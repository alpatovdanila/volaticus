# DEATHTERRA Runtime — Architecture Review

*Reviewed at commit `43c9544` (2026-07-17). Scope: the game runtime only — `src/game/**` (24 modules, ~3.2k lines)
plus the runtime-facing surface of `src/inventory/{effects,preview,factory,gltf,materials,sfx,schema}.ts` and
`src/lib/lighting.ts`. The editor (`src/editor/**`) is out of scope by design.*

*Method: six parallel subsystem mappers built ground-truth maps of every module (state owned, dependency edges,
per-frame command/data flow); five analysts audited them through separate lenses (SoC/SOLID, coupling/IoC, DRY,
frame-loop/data-flow, future-readiness vs GAME.md); 74 raw findings were merged to 30 and **every one was
adversarially verified against the actual code** — 29 survived (with corrections), 1 was refuted. Every claim below
carries file:line evidence that has been independently re-checked.*

---

## 1. The runtime at a glance

### 1.1 Subsystem inventory

| Layer | Modules | Role |
|---|---|---|
| **Data / config** | `level.ts`, `system.ts`, `userPrefs.ts` | Level definition (proto file format), the live gameplay registry, persisted per-machine graphics prefs |
| **Composition root** | `main.ts` (543) | Boot ordering, arena build, system wiring, **the frame loop**, and (today) a lot more — see R7 |
| **Player** | `player.ts`, `locomotion.ts`, `input.ts`, `targeting.ts` | Stance FSM → weight-blended locomotion → device polling → sticky target selection |
| **Enemies** | `zombies.ts` (415), `waves.ts`, `steering.ts`, `corpses.ts` | Pooled horde + per-enemy FSM, wave pacing, separation steering, baked-corpse instancing |
| **Combat** | `projectiles.ts`, `ultimate.ts`, `obstacles.ts` | Instanced bolts + segment collision, condition-based ultimates, AABB cover/LOS/navigation math |
| **Presentation** | `effectsManager.ts`, `blood.ts`, `casings.ts`, `orbs.ts`, `lights.ts`, `audio.ts`, `post.ts` | Budgeted particles, instanced decals/casings, fixed dlight pools, semantic-id audio facade, GTAO/tilt chain |
| **Dev chrome** | `tuning.ts`, `settings.ts`, HUD/perf/fullscreen code in `main.ts` | Registry sliders, level-lighting/graphics panels, debug + perf readouts |
| **Shared with editor** | `inventory/{factory,preview,effects,gltf,materials,sfx,schema}`, `lib/lighting.ts` | Entity building, state/event preview machine, chunk pools, KTX2 materials, sample player, HDRI/sun/shadow rig |

### 1.2 Overarching mechanisms (the house style)

These are the load-bearing conventions everything else leans on. They are the architecture's strongest asset —
consistent, documented in comments, and mostly honored:

1. **Registry-first tuning** — gameplay magnitudes live in `system.params`, *read live every frame* by consumers
   (verified: 8 modules, ~20 read sites). Ultimates/sliders/console mutate it; effects are instant everywhere.
   This is the designated surface for the future upgrade system (`system.ts:1–5`).
2. **Level data vs user data** — lighting/wave/arena config is LEVEL data (`level.ts`); AA/GTAO/aniso are USER
   prefs (`userPrefs.ts`, localStorage). The settings panel edits each in its proper home.
3. **Inventory indirection** — the game speaks semantic ids (`sfx('flesh_hit')`, entity docs, material ids);
   `inventory/*` docs bind them to files. Content swaps never touch game code.
4. **Everything batched** — bolts, blood, casings, corpses (per part), severed limbs, orb spheres are each ONE
   `InstancedMesh`; corpses *bake* their skinned death pose into static geometry and free the skinned entity back
   to the pool. Draw calls stay flat under carnage (~50 at 100+ corpses).
5. **Fixed light pools** — the r185 WebGPU pipeline bakes the light COUNT; all `PointLight`s (6 bolt + 12 zombie +
   5 orbs) are created before first render and lent/released, never added/removed. `lend()` returning `null` is a
   legal answer (graceful unlit degradation).
6. **Pooling + budget custody** — enemies pool and re-dress; corpses/chunks/blood/casings/voices each have an
   explicit cap with an owner that evicts. Systems *dereference*; custodians decide lifetime.
7. **Comment-enforced r185 landmines** — cached-shadow-under-post-chain (`main.ts:514–521`), KTX2-before-materials,
   lights-before-first-render. Correct today, but protected only by comments (see R9).
8. **Dev-hooks contract** — `window.__sys` (registry), `window.__game` (system handles), `window.__stick`/`__ult`
   (synthetic input) form a deliberate, scriptable verification surface.

### 1.3 Command flow and data flow

**Direction of command is strictly top-down; data flows back via return values and injected callbacks.** No game
module imports `main.ts`; nothing in the simulation layer imports presentation. The dependency graph is acyclic
(one soft exception: `level.ts → waves.ts`, R17).

**Boot (strict order — the sequencing IS a contract):** `renderer.init` → `configureKtx2` → `setAnisotropy` →
`rig.applyParams(levelLights)` → **light pools + orbs (before first render)** → material catalog fetch →
`buildArena` (returns obstacle boxes) → player build → effect/blood/casings systems → audio → corpse batch → horde
→ waves → shadow fit → `whenTexturesReady` → initial shadow flush → panels → frame loop.

**Per frame (`main.ts:435–528`):**

```
info.reset → dt clamp
→ target proposal: horde.targets() → range+LOS filter → targeting.select() → aimPoint
→ ultimate: pollActionPress → activate? → update(dt)
→ input: pollMove → player.update(dt, move, aimPoint)     [stance FSM → locomotion → obstacles push-out]
   ↳ onShot callback fires synchronously from inside mixer.update (bolt/spark/casing/sound fan-out)
→ footstep cadence (main re-derives gait phase — R12)
→ projectiles.update(dt, horde.targets())                  [segment vs sphere vs obstacle slabs]
→ HIT LOOP: horde.hit() → HitResult → {blood, decals, sfx, ultimate.onKill, hitLog}   ← de-facto event dispatcher
→ waves.update → horde.update (chase/navigate/separate/lights/corpse-bake) → fx/blood/casings update
→ audio listener ← player position → camera lerp → HUD strings → render (direct or post chain)
```

**Callbacks flowing upward (control inversion points):** `player.onShot`, `waves.onWaveStart/onCleared`,
`Horde`'s injected `sfx` closure + `generation` getter, `EffectDeps`/`PreviewDeps` (dismember), settings panel
`onLights/onGraphics/onOrbs`, tuning buttons. These are the right *kind* of seam — the problem is there are now
**three competing conventions** for the same job (injected closure vs. inline hit-loop dispatch vs. dead hook),
which is the single most consequential finding (R1).

---

## 2. Assessment by principle

### Separation of concerns — **good bones, one overloaded room**

The module-per-mechanism decomposition is genuinely clean: steering knows nothing about zombies, obstacles is pure
math with no owner bias, corpses knows nothing about how things die, targeting selects but doesn't validate,
audio's facade cleanly splits semantic ids from playback. The glaring exception is `main.ts`: beyond its legitimate
composition-root duties it owns target-validity *policy*, the weapon fire *behavior*, footstep *cadence logic*, the
entire hit/kill fan-out, two HUD renderers, perf EMA math, and fullscreen chrome (R7). Every planned system (XP,
doors, mobile HUD) currently has nowhere to land except this file.

### SOLID

- **SRP** — Strong in the leaves, violated in the root (R7) and smeared for one concept: "what a shotgun is" lives
  in three files (R11).
- **OCP** — The best test is "what does adding X touch?" Adding a *sound*: one JSON doc — excellent. Adding an
  *ultimate*: one class — excellent (the `UltimateAbility` redesign paid off). Adding an *interior wall*: level
  data — excellent. Adding an **enemy type**: currently blocked by Horde's singleton clip/tuning state and
  hardcoded clip names/HP/heights (R2) plus corpse batching keyed without type (R4) — this is the biggest OCP
  failure and it's on the critical path of milestone 2. Adding a **room**: impossible without a page reload —
  nothing has teardown (R3).
- **LSP** — One true violation, in a shared module: `EntityPreview`'s GLB path silently drops authored cues/
  ambient/despawn that the procedural path honors (R20) — two contracts under one API.
- **ISP** — Interfaces are small and honest (`UltimateAbility`, `MoveInput`, `WaveDef`). A handful of dead
  surfaces misrepresent contracts (`player.invincible` read by nothing, `waves.onCleared` fired into null,
  `system.reset()` never called) — cheap to fix, R26.
- **DIP** — Generally good: Horde takes injected collaborators, panels take mutation targets + callbacks,
  obstacles/steering are dependency-free math. Two inversions point the wrong way: `level.ts` (data) imports from
  `waves.ts` (system) (R17), and boot hard-depends on a dev-server endpoint (R25).

### Coupling & cohesion — **low coupling overall; three hidden couplings that will bite**

Explicit constructor injection dominates, and module boundaries map 1:1 to responsibilities. The dangerous
couplings are the *implicit* ones the type system can't see:

1. **Time**: five gameplay mechanisms independently read wall-clock (`performance.now()`) while the sim runs on
   clamped `dt` — they all silently desync the moment a pause/upgrade screen exists (R5).
2. **Identity**: three modules share the unwritten convention "`z.built.group` IS the enemy" while zombies pool
   and re-dress those groups forever; `Targeting` holds that identity across frames (R13).
3. **Order**: `aimPoint` correctness rests on statement order in `frame()` plus the fact that `onShot` fires
   synchronously from inside `mixer.update` (R14); boot correctness rests on comments (R9).

`system.params` as a global registry is a *deliberate* coupling and mostly a good one — but it is multi-writer,
and the ultimate's absolute snapshot/restore already clobbers concurrent writers (R6). This is the registry
pattern's one structural hazard, and the upgrade system will step on it in its first week.

### DRY — **honest duplication mostly; five real violations**

The review explicitly distinguished honest duplication (the five eviction policies genuinely differ; the three
audio/effect limiter mechanisms guard different things) from mechanism duplication. Real violations: the
InstancedMesh construct/flush ritual ×6 with drift already visible (R23), the footstep gait math duplicated *and
already disagreeing* with locomotion's (R12), angle-wrap ×3 / exp-damp ×4 (R24), the on-field zombie predicate ×2
(inside R15), dev-panel slider plumbing ×2 (R27).

### Inversion of control — **right pattern, inconsistent dialects**

Injection is everywhere it should be, but in three shapes (direct object, semantic closure, value-getter closure)
mixed in one signature (Horde's 8 positional args, R21), and the biggest inversion opportunity — gameplay facts —
is still hand-rolled in the composition root. The project's own rule ("introduce a typed gameplay-facts emitter
when the first real fan-out lands") has had its precondition met several times over: `enemyDied` fans out to 4
consumers, `enemyHit` to 5, `shotFired` to 5 (R1).

### Verdict on readiness

**The foundation is solid — the conventions are right, the perf architecture is real, and the seams are mostly
where they should be.** The risk is concentrated and specific: (a) the fact fan-out is at the point where every
new system makes the hit loop worse, (b) enemy-type assumptions are baked into exactly the three modules milestone
2 must touch, (c) the registry has a multi-writer hazard on the upgrade system's landing strip, and (d) time and
identity are implicit contracts. All four are cheap now and expensive later. Fix Tier 1 before building the next
gameplay system and the base will hold.

---

## 3. Improvements, most important first

Severity: ★★★★ = foundation risk that compounds with every added system · ★★★ = will bite the next milestone ·
★★ = structural debt, fix when touching the area · ★ = hygiene.

### Tier 1 — do these before adding the next gameplay system

**R1 ★★★★ Introduce the typed gameplay-facts emitter — the deferral precondition is met.**
The hand-rolled fan-out now exists many times over: `shotFired` → 5 consumers (`main.ts:405–422`, including a raw
`window.setTimeout` recock at `:418`), `enemyHit` → 5 (`:475–493`), `enemyDied` → 4, `wallHit` → 2, and
`waveStarted` does a closure round-trip (`main.ts:243–246` → `zombies.ts:99`). Three routing conventions coexist:
Horde's injected sfx closure (`zombies.ts:264`), main's inline dispatch (`:480–483`), and a dead single-slot hook
(`waves.onCleared` fired at `waves.ts:73`, assigned nowhere). The kill kind is hardcoded at the call site
(`main.ts:485 — ultimate.onKill('zombie')`) with a comment admitting the problem.
**Fix:** `src/game/events.ts` — a tiny *synchronous* typed emitter over a closed fact union
(`shotFired{muzzle,dir,pellets}`, `enemyHit{kind,at,dir,hp,severed}`, `enemyDied{kind,at,wave}`, `wallHit{at}`,
`waveStarted{n}`, `waveCleared{n}`). Horde emits hit/died facts, WaveController emits wave facts; blood/audio/
ultimate/hitLog/XP-tomorrow become one-line subscribers. Synchronous dispatch keeps frame order identical.
*Verifier correction to honor:* Horde's `z.type` is the entity-doc id (`'alyosha'`), not the gameplay kind
(`'zombie'`) — the archetype record (R2) should carry the kind so the fact reports the right vocabulary.

**R2 ★★★★ Per-enemy-type archetype records — Horde's singleton state hard-blocks a second enemy.**
Horde is externally multi-type (docs map, weighted `WaveDef.spawns`, per-type pooling) but `deathDur/walkDur/
walkClip/walkProfile` are instance singletons overwritten by whichever type fresh-built last (`zombies.ts:81–87`,
`:154–161`). Concretely, with a second type: `existingAction(this.walkClip)` misses cross-type (`:290`) → silent
fallback to the wrong LPM/walkDur; `die()` uses the wrong type's death duration (`:402`) → corpses bake
mid-animation. Clip names (`'Walking'`, `'Zombie Death'`, `'index'`), `HP=5`, `AIM_HEIGHT`, `ZOMBIE_R` are consts
inside Horde (`:30–31`, `:25`).
**Fix:** `Map<type, Archetype>` built at each type's first spawn: `{deathDur, walkDur, walkClip, walkProfile, hp,
aimHeight, radius, kind, clipNames}` — clip names and hp/aimHeight sourced from the EntityDoc (or a small per-type
config beside `docs`), so a new enemy is *data*, not a Horde edit.

**R3 ★★★★ Create the arena-session seam — rooms/doors currently require a page reload.**
Nothing built in `start()` can be torn down: `buildArena()` discards its mesh handles; the `obstacles` array is
aliased by raw reference into four systems (`main.ts:220/228/244/325/451`) with "mutate in place" as the only safe
update protocol — unstated and unowned; Horde/CorpseBatch/BloodSplatters have no `clear()`; `WaveController` takes
one `WaveDef` forever (`waves.ts:60–63`); `UltimateController.deactivate` is private, so a transition can't cancel
an active ult — which would leak its registry buff across rooms (compounds R6); `system.reset()` has zero callers.
**Fix (staged):** now — wrap obstacles in a named owner (`CollisionWorld { readonly boxes; set() }`), add
`clear()` to CorpseBatch/BloodSplatters, public `cancel()` on UltimateController, and stop adding reset-less
modules. Before milestone 5 — an `ArenaSession` owning the per-room graph (arena meshes, horde, waves, corpses,
blood, casings, projectiles) with `build(level)/dispose()`; boot keeps what must survive (renderer, rig, post,
fixed light pools — rooms must fit the boot-time light budget by design).

**R4 ★★★ Key CorpseBatch parts + material by enemy type.**
The instanced-part map is keyed by bare part name (`corpses.ts:24`), so the first species' bake is canonical
forever — spitter corpses would render as zombie bodies; the shared material is captured once, by *live
reference*, from the first-ever corpse (`:81–84`), so a runtime material mutation on the live pooled entity would
restyle every corpse retroactively. `zombies.ts:245` passes no type — the only non-type-aware link in an
otherwise-ready seam. **Fix (~10 lines):** `corpses.add(built, type, gen)`, key parts `${type}/${part}`, capture
one material per type *as a clone* (corpse-batch-owned, so it stays within the never-dispose-shared-materials rule).

**R5 ★★★ Consolidate gameplay timing onto one sim clock.**
Five gameplay mechanisms read wall-clock while the sim runs on clamped dt: the fire-rate gate
(`locomotion.ts:116–119`), stopping-power windows (`zombies.ts:300/383`), effect budgets
(`effectsManager.ts:111`), the sfx MIN_GAP (`audio.ts:23`), and the recock `setTimeout` (`main.ts:418`). The
upgrade-pick screen is a pause by genre convention — under pause, flinch windows expire, the fire gate elapses,
and the recock fires into the menu. The hidden-tab interval driver already runs sim frames at a different
real-time density.
**Fix:** a game-time accumulator ticked once in `frame()` (`clock.ts` or a field beside the registry); switch the
fire gate, `lastHitAt`, and effect budgets to it; make the recock a dt-decremented pending entry (or a delayed
fact on R1's bus). Deliberately *keep* audio MIN_GAP and hitLog on wall-clock (they guard the ear and diagnostics,
not the sim) — and say so in a comment.

**R6 ★★★ Replace the ultimate's absolute snapshot/restore with a registry modifier layer.**
`ZombieEaterUltimate` snapshots absolute values and blind-writes them back (`ultimate.ts:33–48`). The registry is
*deliberately* multi-writer (sliders `tuning.ts:66`, `__sys`, planned upgrades per `system.ts:3–5`): buy "+20%
fire rate" mid-ult and `deactivate()` silently erases the purchase. Also same-quantity-two-homes:
`SHOTGUN_SPREAD` const vs `params.bulletSpread`.
**Fix:** keep `params` as the plain read surface, but derive it from `base + modifier stack` (named multiplier/
override entries), recomputed on any change — every existing live read is untouched, so registry-first is
preserved. Ults push/pop modifiers; upgrades/sliders write base. *Interim 6-line fix:* revert-by-inverse
(`p.fireRate /= ROF_MULT`) so concurrent base edits survive. Also make tuning sliders re-read `params` instead of
caching mount-time values.

### Tier 2 — correctness and robustness, next in line

**R7 ★★★ Split policy and presentation out of `main.ts`.**
Extract three modules, no new abstractions: `hud.ts` (debug + ult + perf readouts over read-only getters),
`devChrome.ts` (overlays/fullscreen/panel mounting), `combat.ts` (aim policy `:443–454`, fire handling
`:405–422`, hit fan-out `:475–493` — the natural producer/subscriber home once R1 lands). `main.ts` keeps boot
ordering, the frame skeleton, and wiring — the parts where sequencing comments are the actual contract.

**R8 ★★★ Catch `beginWave`'s fire-and-forget async + validate wave enemy types at fill time.**
`void this.beginWave()` (`waves.ts:80`) with serial awaits and no catch; any rejection leaves `state='spawning'`
forever (permanent early-return at `:68`) — a silent soft-lock. **The verifier proved this is live today, not
future:** alyosha's GLB loads lazily inside wave 1's first `spawnAt` (`zombies.ts:151`); one failed fetch
soft-locks the run. **Fix:** validate every `def.spawns[].type` against the docs map in the WaveController ctor
(fill-time, per the project's stated preference), and `.catch` in `beginWave` that logs loudly and still sets
`'fighting'` (degrade to a short wave, never lock).

**R9 ★★★ Turn the comment-enforced boot contracts into tripwires; guard the light-count law against flash docs.**
Four sequencing contracts are comment-only. One violation path is *live code*: `EffectSystem.play` adds a raw
scene `PointLight` for any effect doc with `flash` (`effects.ts:476–481`) — the exact pipeline-poisoning event the
fixed pools exist to prevent; latent only because today's three game effect docs define no flash, and the editor's
warmup (which pre-compiles the flash variants) runs only in the editor. **Fix:** 2–3-line asserts —
`makeSlotMaterial` throws if the catalog is unset; LightPool/Orbs ctors assert first-render hasn't happened;
freeze the scene light count after frame 1 and `console.error` on change. For flash, invert the dependency: give
`EffectSystem` an optional light provider (editor backs it with `new PointLight`, game backs it with a pool or
omits it → flash skipped, doc still valid).

**R10 ★★★ Audio facade hygiene (three defects).**
(a) Unknown sfx ids fail silent forever (`gated()` returns null, `audio.ts:20–27`) — a renamed doc = permanent
silence; the id vocabulary is known at module load. Declare `GAME_SFX` and `assertSfxIds()` at boot (fill-time
validation). (b) Ambience connects straight to `ac.destination` (`audio.ts:121`), bypassing the 0.5 master gain —
the same bug already fixed for positional voices, contradicting the one-bus rationale 45 lines above. (c)
`sfxAt` stamps the MIN_GAP gate *before* the voice-budget check (`:60–64`) — a budget-dropped sound still blocks
its id for the window. Reorder.

**R11 ★★★ Give weapons a home.**
"What a shotgun is" is smeared: `pellets > 1` sound heuristic + 280ms `setTimeout` (`main.ts:409–421`), consts in
`ultimate.ts:25–27`, and the rifle existing only implicitly as registry defaults. **Fix:** a `WeaponDef` record
(`{sfxShot, sfxAfter?, afterDelay?, pellets, spread, rofMult}`); active weapon is a registry entry; the ult swaps
the record (or pushes an R6 modifier). "Add a weapon" becomes one record; the recock becomes a dt-delay in
`combat.ts`.

**R12 ★★★ Footsteps: one owner for gait phase.**
`main.ts:462–470` re-derives loops/s with a *different band predicate* than locomotion (hard
`speed <= walkSpeedMax` vs mag hysteresis 0.55/0.45; strafe/backpedal always use runLpm; no timeScale clamp) —
audible steps and visible feet already disagree in the hysteresis band and while aim-strafing (a core archero
state). **Fix:** Locomotion accumulates step phase off the *active action* and exposes `onStep` (mirrors
`onShot`); main's block collapses to `sfx('footstep')`.

**R13 ★★★ Give enemies a stable handle — Object3D identity is held across pooled lifetimes.**
`targets()` exposes `z.built.group` as identity, `Targeting.current` retains it across frames, `horde.hit()`
linear-scans by `===`. Pooled groups are re-dressed forever, so a recycled enemy `===` a stale lock. Masked today
by wave gating; reachable via pacifist mode (`main.ts:444` skips select, freezing the lock); becomes real the day
mid-wave spawning (doors/bosses) lands — and the planned instanced horde has *no* per-enemy Object3D at all.
**Fix (~20 lines):** target payload becomes `{id, point}` (per-zombie `spawnSerial` bumped on re-dress);
`Targeting` keys on the id; `hit(id)` indexes directly (also kills the per-hit linear scan).

**R14 ★★ Pass the aim through `onShot(aim)` instead of a shared closure variable.**
`onShot` fires synchronously from inside `mixer.update`; main's handler reads the frame-scoped `aimPoint` closure,
valid only because selection textually precedes `player.update` (`main.ts:443/453/460`). `PlayerController.update`
already *receives* the aim — store it, change the callback to `onShot(aim)`, and the order-dependence disappears
(also documents the payload of R1's `shotFired` fact).

**R15 ★★ Snapshot `horde.targets()` once per frame; single-source the on-field predicate; de-allocate the hot path.**
`targets()` is called twice per frame (`main.ts:448`, `:474`) with a fresh array + wrapper + cloned Vector3 per
zombie per call — provably identical data (nothing mutates between). At the planned 100-enemy horde that's ~24k
allocations/s of GC churn on the mobile target. The four-term liveness predicate is duplicated verbatim
(`zombies.ts:347`, `:370`); `navigateAround` allocates corners/result/`[b]` per box per zombie per frame while its
sibling `pushCircleOut` is already allocation-free. **Fix:** snapshot once at frame top (2 lines,
semantics-preserving — verified); persistent array + per-zombie cached Vector3s; extract `onField(z)`; out-params
for `navigateAround`.

### Tier 3 — structural debt, fix when touching the area

**R16 ★★ Promote balance-facing magnitudes into the registry** — zombie HP=5 (`zombies.ts:30`) sits beside
registry damage in the same equation; `FIRE_RANGE=14` (`main.ts:45`), ult `MAX_CHARGE/CHARGE_PER_KILL`
(`ultimate.ts:66–67` — exactly what an "ult charge rate" card modifies), bolt `SPEED/TTL/HIT_RADIUS`
(`projectiles.ts:16–18`, three lines above a registry read). Graduate those; deliberately *keep* feel constants
(BLEND_RATE, DEADZONE, EMERGE_TIME…) local with a "feel, not balance" tag to stop re-litigation.

**R17 ★★ Move `WaveDef`/`SpawnZone`/`TEST_WAVE` into `level.ts`** (or `waveDef.ts`) — the proto *file format*
currently runtime-imports from the wave *controller* module (`level.ts:8`); the arrow must point system→data.
Zero behavior change; verified cycle-free.

**R18 ★★ Unify the presentation channel** — the doc-authored sfx path is wired to no-ops (`NOOP_DEPS`
`effectsManager.ts:79`; all-stub PreviewDeps `zombies.ts:206–212`) while call sites re-implement sound routing two
other ways; an author adding a death sfx to an enemy doc sees it work in the editor and silently do nothing
in-game. Horde also drives `EffectSystem` directly for gore (`zombies.ts:220/227`), bypassing the manager's
promised policy chokepoint (budgets, future distance culling). Wire real adapters (audio facade behind the deps),
give EffectsManager a dismember passthrough, and delete the stubs. Do *not* unify the three limiter mechanisms
themselves — that duplication is honest.

**R19 ★★ Rename `system.params.damage` → `boltDamage`** before player health lands (3 sites + defaults). The
registry already prefixes zombie params — bare `damage` is the outlier and will collide with the incoming
`zombieDamage` in every HUD/tuning/upgrade context.

**R20 ★★ Fix (or loudly reject) GLB cues/ambient/despawn in `EntityPreview`** — the mixer branch returns before
the cue/ambient/despawn tail (`preview.ts:310` vs `:323/:332/:339`) and `setGlbState` never populates them; every
game enemy is a GLB. No doc authors cues *today* (why this isn't Tier 1), but a cue at an attack clip's strike
frame is the natural melee/spit trigger for milestone 2 — fix it in the shared module (both hosts benefit), or
`console.warn` once per doc so it can't silently no-op.

**R21 ★★ Collapse Horde's 8 positional ctor args into `HordeDeps`** (`zombies.ts:89–101`, call at `main.ts:244`).
Named fields make nullability explicit; R1 shrinks the object further (sfx + generation become subscriptions).
*Verifier correction:* the swap-hazard is real only between the two *function* params (`generation` fits the sfx
slot); the class params are nominally typed and would not compile.

**R22 ★★ Report wall impacts as `{at, normal, t}`** — arena-boundary hits currently report the overshot endpoint
clamped per-axis (up to 0.8m error at the dt clamp; `projectiles.ts:124–131`), and neither wall path reports a
surface normal. "Ricocheting bullets" is on the documented upgrade list and cannot be built on this contract.
`segmentEntryT` already computes per-axis entry internally — return the axis.

**R23 ★★ Package the InstancedMesh construct/flush ritual** — six copies (five clean + one drifted: the burst
mesh omits `DynamicDrawUsage` despite per-frame rewrites, `effects.ts:433–435`), and casings proves the failure
mode: its first `setColorAt` runs inside `update()` on the shot path, creating the instanceColor buffer (a
pipeline-key input) at runtime instead of boot (`casings.ts:100` vs ctor). A ~25-line `instanceBucket.ts`:
defaults applied, color buffer pre-touched at boot, `flush(n)` tail. Eviction policies stay per-system — that
duplication is honest.

**R24 ★★ Extract `wrapPi(a)` + `dampFactor(rate, dt)` (+ `turnToward`)** beside `steering.ts` — wrap-to-±π copied
verbatim ×3, exp-damp ×4, two of them full duplicate turn controllers (`locomotion.ts:216–223` ≡
`zombies.ts:327–332`). steering.ts promises more agent types; each would copy again. The aim spring stays bespoke
(genuinely a different controller).

**R25 ★★ Remove the hard dev-server boot dependency** — `fetch('/__materials')` (`main.ts:130–134`) is an
editor-plugin endpoint (`vite.config.ts:211–231`, dev-only); the game discards the editor-specific fields and
could import the catalog statically like sfx docs already do (`import.meta.glob`). Today a production build fails
mid-boot with an unrelated `SyntaxError` (SPA fallback returns HTML). At minimum: a named, thrown error.

### Tier 4 — hygiene

**R26 ★ Prune or wire dead public surfaces** — `player.invincible` (written, never read — the pacifist toggle's
immunity promise doesn't exist), `waves.onCleared` (fired into null beside a wired sibling), `system.reset()` (no
callers), `WaveController.update`'s ignored `_playerPos` (which hides a doc mismatch: TEST_WAVE's ring comment
says "around the player" but `samplePoint` centers on the origin), `speedFor` export, `LightPool.stats()`,
`Corpse.gen`.

**R27 ★ Deduplicate dev-panel widget plumbing** — settings' row/slider helpers vs tuning's inline re-implementation,
already dimensionally drifted (label 80 vs 110px, chrome alpha 0.8 vs 0.75). Extract `devUi.ts`. (The ult HUD is
game UI, not dev chrome — style it independently.)

**R28 ★ Poll the gamepad once per frame** — `navigator.getGamepads()` is snapshotted twice back-to-back
(`input.ts:52`, `:74`). One `pollInput(): {move, actionPressed}`. *(The original "synthetic ult swallows a real
edge" claim was refuted on verification — the proposed fix was behaviorally identical to current code.)*

**R29 ★ Fix the EffectsManager budget comment** — it says "rolling window" but implements a fixed window
(`effectsManager.ts:71–72` vs `:108–120`), allowing ~2× max in a window-wide span straddling a reset. Fix the
comment (or a 6-line timestamp ring if true rolling ever matters).

---

## 4. Claims checked and cleared

For trust in the above, the adversarial pass also *refuted* or corrected claims that would otherwise have wasted
your time:

- **Refuted:** "a fresh bolt's dlight renders one frame at the park position" — shots always fire inside
  `player.update`, before `projectiles.update` positions lights in the same frame; the claimed frame cannot occur.
- **Corrected:** swapping Horde's `lights`/`corpses` args would *not* compile (nominal typing via private fields) —
  only the two function-shaped params can silently swap (R21).
- **Corrected:** retained `aimPoint` vectors read *frozen* clones, not recycled data (`targets()` clones per call)
  — the order-dependence (R14) is real but the staleness mechanism is milder than claimed.
- **Corrected:** stacked-ultimate snapshot corruption (R6) is not currently reachable — the controller gates
  re-activation; it's a future-composition hazard, with the slider/upgrade clobber being the live one.
- **Scoped:** GLB cue-dropping (R20) has zero present-tense harm — no doc authors cues yet; it's ranked for what
  milestone 2 will hit, not for today.

## 5. Suggested execution order

A practical sequence that front-loads compounding value and keeps each step verifiable in the browser:

1. **R1 events.ts + R7 combat.ts extraction** (they're one refactor: the emitter needs a home) — then R14 falls
   out nearly free, and R26's `onCleared` gets wired.
2. **R2 archetypes + R4 corpse type-keying + R13 stable handles** (one "enemy identity" pass through zombies.ts) —
   unblocks milestone 2's second enemy type.
3. **R6 registry modifier layer + R11 WeaponDef + R19 rename + R16 graduation** (one "registry coherence" pass) —
   lands the upgrade system's foundation.
4. **R5 sim clock** (touches locomotion/zombies/effectsManager/main) — before any pause UI exists.
5. **R8 wave validation + R9 tripwires + R10 audio hygiene** (the fail-fast pass).
6. Tier 3 items opportunistically, whenever the file is already open; Tier 4 in any idle moment.

*Companion docs: [GAME.md](GAME.md) (design north star), [ARCHITECTURE.md](ARCHITECTURE.md) (systems map, written
pre-carnage-batch), [DD_NOTES.md](DD_NOTES.md) (design intent notes).*
