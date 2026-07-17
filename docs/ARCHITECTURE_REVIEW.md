# DEATHTERRA Runtime — Architecture Review (round 2)

*Reviewed at commit `ad74ec9` (2026-07-17), after Tier 1 + Tier 2 of round 1 were implemented. Scope: the game
runtime only — `src/game/**` (33 modules) plus the runtime-facing surface of
`src/inventory/{effects,preview,factory,gltf,materials,sfx,schema}.ts` and `src/lib/lighting.ts`. The editor
(`src/editor/**`) is out of scope by design.*

*Method (unchanged from round 1, plus an audit phase): six parallel subsystem mappers rebuilt ground-truth maps of
every module; **fifteen auditors independently checked each claimed round-1 fix against the code rather than against
the claim**; five analysts then worked the current runtime through separate lenses (coupling/IoC, cohesion/SRP,
DRY/SOLID, lifecycle/correctness, future-readiness vs GAME.md); 20 merged candidates were each **adversarially
verified** — 13 survived (most with severity corrected downward), 7 were refuted. 47 agents, ~3.6M tokens.*

---

## 0. Where this stands

Round 1 found **29 problems, four of them ★★★★ "fix before the next system lands"**. Round 2, over the same runtime
with the same method, finds **13, none ★★★★ and one ★★★**. The four structural blockers are gone: the fact bus
exists, enemies are archetypes with stable ids, the registry layers instead of clobbering, and the arena has a
collision owner.

The honest part: of the 15 fixes round 1 asked for, the audit graded **9 fully done and 6 partial**. Every one of
those six holes has since been closed (commit `ad74ec9`) and re-verified in the browser — they are listed in §1 with
what was actually missing, because *"I implemented R2"* turning out to mean *"I implemented most of R2 and left the
one hardcoded species literal in the file whose header says there are none"* is exactly the failure mode a review
exists to catch.

What remains is a different class of finding than round 1's. Round 1 said *this will break when you add the next
system*. Round 2 mostly says *this is latent, and here is the data that would wake it up*. Nothing on this list
blocks milestone 3 (XP/upgrades).

---

## 1. What round 1 asked for, and what actually landed

| # | Fix | Audit | The hole (all now closed) |
|---|---|---|---|
| R1 | Typed gameplay-facts emitter | **partial → done** | `enemyDied` was emitted at the *call site* (`hit`), not in `die()` — so `killAll()` (the shipped "clear wave" button) killed the horde with no death sound, no blood pool, no ult charge, no log entry; any future death cause would have dropped it too. Now emitted in `die()`. |
| R2 | Per-enemy-type archetypes | **partial → done** | (a) the death-glow fade looked its base up by the hardcoded part name `'crystals'` while discarding the `part` it had in hand — in the file whose header claims "everything species-specific is data". (b) The data R2 *introduced* had no fill-time validation: clip names fell back silently, and each miss is a different subtle wrongness. Both fixed; clip names now throw at first spawn, naming what the model actually has. |
| R3 | Arena-session seam (staged) | **partial → done** | `private world = new CollisionWorld()` defaults meant an omitted argument silently produced a *second, private, permanently-empty* world — every consumer branches on `world.empty`, so it would take the no-obstacles path forever and `world.set(nextRoomWalls)` would never reach it. All collaborators are now required. |
| R4 | Key corpses by enemy type | **partial → done** | The skin was picked by a hardcoded `'body'` with a `?? meshes[0]` fallback. GLB mesh order is arbitrary and `@exposeEmissive` parts carry their own glowing clone — the fallback could dress every corpse of a species in its crystal glow, i.e. R4's own failure mode moved from cross-species to within-species. Skin part is now `EnemyDef` data. |
| R5 | One sim clock | **done** | — |
| R6 | Registry modifier layer | **done** | — |
| R7 | Split `main.ts` | **done** | 543 → ~410 lines; frame loop is a skeleton. |
| R8 | Wave validation + `beginWave` catch | **done** | — |
| R9 | Boot tripwires + flash provider | **partial → done** | `markFirstRender()` ran after the *frame-loop* render, but under the post chain the first real render is the boot `flushShadowDirect()` — which is where r185 bakes the light count in. The entire boot tail was unguarded, and `watchLightCount` would have absorbed a late light into its baseline. Now armed at the boot render. |
| R10 | Audio facade hygiene | **done** | — |
| R11 | `WeaponDef` | **done** | — |
| R12 | Locomotion owns gait phase | **done** | — |
| R13 | Stable enemy handles | **done** | — |
| R14 | `onShot(aim)` | **done** | — |
| R15 | Snapshot targets once | **partial → done** | The "de-allocate the hot path" clause was skipped: `navigateAround` allocated a result object, a corners array, and a throwaway `[box]` **per box, per enemy, per frame** — by the review's own arithmetic a larger steady-state garbage source than the `targets()` buffer R15 *did* fix. Now out-param + module scratch + `segmentEntryTBox`. |

**Pattern worth noting for future passes:** five of the six holes are the same mistake — *the fix edited the exact
line next to the hole and stepped over it*. A silent fallback (`?? 2`, `?? meshes[0]`, `= new CollisionWorld()`)
survives a refactor precisely because it looks like working code. The project's stated preference — validate at fill
time, never fall back — is the antidote, and it is now applied at every seam round 1 opened.

---

## 2. The runtime as it stands

### 2.1 Subsystem inventory

| Layer | Modules | Role |
|---|---|---|
| **Data / config** | `level.ts`, `system.ts`, `weapons.ts`, `enemies.ts`, `userPrefs.ts` | Level definition, the live gameplay registry (base × modifiers), weapon records, enemy archetypes, persisted graphics prefs |
| **Composition root** | `main.ts` (~410) | Boot ordering, arena build, wiring, the frame skeleton |
| **Contracts** | `events.ts`, `clock.ts`, `tripwires.ts`, `entityDoc.ts` | The fact bus, the sim clock, the boot tripwires, doc validation |
| **Player** | `player.ts`, `locomotion.ts`, `input.ts` | Stance FSM → weight-blended locomotion (owns gait phase) → device polling |
| **Enemies** | `zombies.ts`, `enemies.ts`, `waves.ts`, `steering.ts`, `corpses.ts` | Pooled multi-type horde with stable ids, wave pacing + fill-time validation, separation, baked-corpse instancing |
| **Combat** | `combat.ts`, `projectiles.ts`, `targeting.ts`, `ultimate.ts`, `obstacles.ts` | Aim policy + fire path + fact production + reaction wiring; instanced bolts; sticky targeting; condition-based ultimates; `CollisionWorld` + AABB math |
| **Presentation** | `effectsManager.ts`, `blood.ts`, `casings.ts`, `orbs.ts`, `lights.ts`, `audio.ts`, `post.ts` | Budgeted particles, instanced decals/casings, fixed dlight pools, semantic-id audio facade, GTAO/tilt chain |
| **UI** | `hud.ts`, `devChrome.ts`, `tuning.ts`, `settings.ts` | Ult bar (gameplay) + debug/perf readouts (dev), overlay container + fullscreen, registry sliders, level/graphics panels |

### 2.2 The house style, now that it's coherent

Six mechanisms carry the runtime, and after round 1 they finally agree with each other:

- **Facts, not calls.** Producers report past-tense facts (`events.ts`); blood, audio, the ultimate and the hit log
  subscribe. Synchronous dispatch keeps frame order identical to the hand-written calls it replaced. *One*
  routing convention where there were three.
- **Registry-first tuning, layered.** `params` is derived (`base × named modifiers`), so an ultimate and a
  mid-fight upgrade compose instead of clobbering. Every existing live read is untouched.
- **Data over code.** A species is a record (`enemies.ts`), a gun is a record (`weapons.ts`), a level is a record
  (`level.ts`). Clip names, hit points, sounds and ballistics are all data — and now all validated at fill time.
- **Pools everywhere, fixed at boot.** Lights, bodies, bolts, chunks, casings. The light count is frozen before
  the first render because r185 bakes it into every pipeline — enforced by tripwires, not comments.
- **Batching as the default.** Corpses, blood, casings, limbs and bolts each cost ~1 draw call regardless of count.
  ~100 corpses at ~39 draws, measured.
- **One clock.** `sim.now` for anything the sim governs; wall-clock only for the ear (audio MIN_GAP) and the human
  (dev hit log), each with the reason written down.

### 2.3 Assessment against the round-1 axes

- **Separation of concerns** — good. `main.ts` is boot + skeleton + wiring. The one debatable module is `combat.ts`,
  which holds producers *and* the reaction subscriptions; a verifier specifically defended this as a deliberate
  two-part file, and the alternative (a `reactions.ts`) is a trivial later split if it grows.
- **Control inversion** — good. The bus, `CollisionWorld`, the `FlashLights` provider and `WeaponDef` all invert
  dependencies that used to point at the composition root. The Horde no longer holds a closure back into `main`.
- **DRY** — one real residue: shortest-angle wrap ×3 and exponential damp ×2 (§3, T3-1). Everything else the lenses
  flagged as duplication was refuted (e.g. LOS "two implementations" — both call the same helper).
- **SOLID** — open/closed now holds for the extensions that matter. Adding a weapon, an ultimate, a fact + subscriber,
  or an enemy species is a record plus (for a species) an entity doc. Adding player health is the one that still
  needs new code, and it has a clean home.
- **Readiness** — milestone 3 (XP/upgrades) is genuinely unblocked: three of GAME.md's five upgrades are already
  `GameParams` writes. Rooms/doors (milestone 5) is the one with real work left, and it is scoped in T2-2.

---

## 3. Findings

★★★ = structural debt worth scheduling · ★★ = latent, fix when touching the area · ★ = hygiene.
*Severities are the verifiers' corrected values. Several findings were argued down from their author's claim; where
a verifier's correction materially changed the story it is folded into the text below.*

### Tier 2 — latent, and the data that wakes them up

**T2-1 ★★★ The arena perimeter is not solid for enemies — only the player and bolts are clamped.**
`buildArena` comments that "the perimeter is handled by the ±arenaHalf position clamps" (`main.ts:141`), but the
perimeter walls are scene meshes only (`main.ts:166`) and contribute nothing to `world.boxes` — only
`level.interiorWalls` do. Those clamps exist in exactly two places (`player.ts:123-124`, and bolts via
`wallHalf` at `projectiles.ts:125`). **The Horde has no bounds at all**: its chase integration and `separate()`
write positions with no clamp of any kind. The comment's plural "clamps" reads as policy; it is a per-consumer
opt-in the horde never took.
*Masked today by data alone*: TEST_WAVE's ring tops out at `rMax 10` inside `arenaHalf 11`, and the chase always
pulls inward. A spawn zone at the wall — the natural "they come from the perimeter" wave — or any future
knockback impulse sends bodies through a wall the player can neither shoot through nor walk through. The sharp
half is targeting: an escaped body still passes the LOS test (which consults only `world.boxes`), so the player
locks on and fires bolts that die at 11.75.
**Fix:** push the perimeter into the `CollisionWorld` as four boxes so `pushCircleOut`/`segmentEntryT`/
`navigateAround` treat it like any other wall, and delete the bespoke clamps. Pairs naturally with T2-3.

**T2-2 ★★ The room/run seam is staged asymmetrically — the two systems that define a room got no seam.**
`CorpseBatch.clear()`, `BloodSplatters.clear()`, `CollisionWorld.set()`, `UltimateController.cancel()`,
`System.reset()` and `sim.reset()` all exist, are unwired, and are explicitly justified by a room transition. But
the Horde's public surface has no despawn/reset/dispose, and `WaveController`'s `countdown`/`state` are private
with no reset. `killAll()` is not a substitute: it calls `die()`, which starts a ~2s death clip — so a transition
written against the staged seam (`killAll(); corpseBatch.clear(); world.set(next)`) would have room 1's 14–18
corpses **bake into the freshly-cleared batch ~2s later, at room 1's world transforms**, materialising on room 2's
floor. `aliveCount()` stays non-zero across the transition, so a new WaveController would sit in `'fighting'`.
**Fix:** finish the seam before its first caller. `Horde.despawnAll()` running the same terminal block as the bake
path *without* `corpses.add()` (park immediately, no corpse — the pool machinery already does everything except
skip the animation); keep `killAll()` as the theatrical dev button it is. Add `WaveController.reset()` and zero
`charge` in `cancel()`. **This is the prerequisite for milestone 5, and it is the single largest remaining item.**

**T2-3 ★★ The arena has no owner; its one dimension becomes five hand-derived bounds.**
`CollisionWorld` exists because "rooms and doors mean this set changes at runtime" — the *other* half of a room got
no such treatment. `buildArena` adds the floor, four perimeter walls and every interior wall straight into `scene`
and returns only `Box[]`: no group, no mesh list, nothing in the runtime can remove or dispose room 1's geometry.
Separately `arenaHalf: 11` is documented "walls at ±half; player clamped inside", and four modules each apply their
own fudge — not one resulting bound is 11 (floor ±12, wall faces ±12.0, player clamp ±10.55, bolt wall ±11.75).
*Verifier correction honoured:* this is **not** a single-source-of-truth violation — the value 11 exists once and
all five bounds are expressions derived from it at construction. The defect is narrower: the derivations are
scattered, and `level.ts:19`'s comment is simply false (walls are 1.0m outside ±half at their inner faces).
**Fix:** have `buildArena` return the room (`{group, boxes, half}`) rather than a side effect, so a swap is
`scene.remove(group)` + dispose + `world.set(boxes)`; collapse the derived bounds into that object, computed once.

**T2-4 ★★ The bolt resolver cannot express per-species body size.**
`HIT_RADIUS = 0.38` is a module constant and the only radius the resolver has; `EnemyTarget` is `{id, point}`, so
size never reaches it.
*Verifier corrections honoured:* there is **no current defect** (alyosha is the only species and 0.38 is
feel-tuned for it), and `EnemyDef.radius` explicitly scopes itself to "separation + wall push-out" — so this is not
a case of the table advertising a hit radius that's ignored. What *is* defensible today regardless of species count
is the constant's derivation: `0.38` is documented as "15% tighter than 0.45", and the only 0.45 in the game is
`PLAYER_RADIUS` — the zombie's hit radius is derived from the *player's* body radius while alyosha's own radius
(0.35) sits unused two files away.
**Fix:** put `radius` on `EnemyTarget`, fill it beside the existing `aimHeight` read, and read `t.radius` in the
resolver. Bosses (milestone 5) are what make this load-bearing; a large model hit-tested by a 0.38m ball at
`aimHeight` takes shots through the chest.

**T2-5 ★★ The spawn-reveal transition is overloaded onto `spawnDelay > 0`, so `stagger: [0, 0]` yields invisible enemies.**
Everything that makes an enemy enter the fight — the reveal, the drop under the floor, the rise pose, the crystal
light, the `enemySpawned` emit — lives inside the `if (z.spawnDelay > 0)` expiry branch. With `delay === 0` that
block never runs even once, `emergeLeft`/`riseLeft` are both 0 so their branches are skipped too, and execution
falls straight through to the chase. The body stays `visible = false` forever while `onField()` returns true.
*Verifier corrections honoured:* the consequence is **not** lethal (nothing damages the player yet, and the horde
has no attack code) — it is invisible-but-still-shootable chasers, no rise sound, no crystal light. And it is
latent: the only WaveDef in the codebase uses `[0, 1.5]`, and `Math.random()` returning exactly 0 is a ~2⁻⁵³ event.
It needs *authored* `[0, 0]` — the natural way to write "all at once".
**Fix:** stop overloading one number as both "still waiting" and "not yet revealed" — an explicit
`stage: 'queued' | 'emerging' | 'rising' | 'chasing'`, or test before decrementing so the reveal runs on the
falling edge including 0. Validate the stagger range in the `WaveController` ctor beside the checks already there.

### Tier 3 — hygiene

**T3-1 ★ Shortest-angle wrap ×3 and exponential damp ×2, copy-pasted.**
Verbatim `while (d > Math.PI) d -= Math.PI*2` at `locomotion.ts:142-143`, `locomotion.ts:258-259` (twice in one
module) and `zombies.ts:384-385`; two exponential heading damps with module-local `TURN_RATE` (14 vs 7).
*Verifier correction:* the sibling claim about the two module scratch objects was misdiagnosed — **reject** that
half; the scratch objects are correct as they are. Extract `wrapPi(a)` and `dampFactor(rate, dt)` beside
`steering.ts`; leave the rates local (they're feel constants).

**T3-2 ★ Blood over cap draws the OLDEST splats, so fresh blood can be invisible for up to 0.7s.**
`splat()` marks one victim fading when at cap but pushes unconditionally, so the list exceeds `MAX_SPLATS` under
sustained fire (a marked victim takes `FADE`=0.7s to leave). `update()` writes instances in insertion order while
`i < MAX_SPLATS` — so the undrawn splats are the *newest* ones. Neither call site is throttled (both bypass the
EffectsManager budget). *Verifier:* real, but the overshoot is ~`rate × FADE` and self-limiting; the proposed
"evict synchronously" fix was judged unsafe. Prefer: in `update()`, skip the first `max(0, len - MAX)` entries.

**T3-3 ★ The tracer colour has two homes, and the "single source of truth" comment is false.**
`BOLT_COLOR` drives the bolt's *point light* and the orbs; the tracer **mesh** colour is an independent literal
(`color(2.6, 1.15, 0.18)`). `main.ts`'s "change the tracer, the orbs follow" is therefore misleading — editing
`BOLT_COLOR` changes the glow and the orbs but not the bolt you actually see.

**T3-4 ★ Horde keeps a duplicate wave counter, synced over the bus with no teardown.**
`Horde.wave` mirrors `WaveController.wave` via a subscription whose unsubscribe fn is discarded (no `Horde.dispose`
exists). Harmless today; it is a second home for a value with a clear owner, and the subscription outlives nothing
because nothing can be torn down yet. Fold into T2-2.

**T3-5 ★ A fact subscriber re-derives `system.params` in the middle of the loop that reads it.**
`combat.update` iterates `shots.hits` → `horde.hit` reads `system.params.damage` live → emits `enemyDied` →
synchronously → `ultimate.onKill` → `system.equip` → `recompute()`. So bolt *k+1* in the same frame is resolved
against a registry the ult just rewrote. *Verifier:* this is **a one-line contract gap in `events.ts`, not a
damage bug** — reduce to documenting that a subscriber may mutate the registry, and that producers therefore must
not cache `params` across an emit. (Today nothing does.)

**T3-6 ★ The deferred-sound queue is an audio concern parked in `CombatSystem.update`.**
*Verifier:* keep the observation, drop the rationale — its two siblings (per-id MIN_GAP, the voice budget) both
live in `audio.ts`. If a second caller ever wants a delayed sound, hoist it to `audio.ts` as
`sfxAfter(delay, id)` + a `tickAudio(dt)` pump — which must take the sim dt, since the recock is gameplay-timed.

**T3-7 ★ `devChrome` overstates its own guarantee.** It owns the container and its panels, but the dev/gameplay
classification of the two HUDs is decided at their call sites in `main.ts` (PerfHud is dev-only purely because
`main` passes `overlays`). Narrow the comment, or move both mounts inside.

### Carried over from round 1 (Tier 3/4, not re-audited)

Still open and unchanged: **R17** (move `WaveDef`/`TEST_WAVE` into `level.ts`), **R18** (doc-authored sfx path
wired to no-ops), **R19** (`params.damage` → `boltDamage` before player health lands), **R20** (GLB
cues/ambient/despawn in `EntityPreview`), **R21** (collapse Horde's ctor into `HordeDeps` — partially addressed:
the args are now all required and documented, but still positional), **R22** (`{at, normal, t}` wall impacts —
now also the enabling primitive for a ricochet upgrade), **R23** (package the InstancedMesh construct/flush
ritual — six copies), **R25** (hard dev-server boot dependency on `fetch('/__materials')`), **R26** (dead public
surfaces), **R27** (dev-panel widget plumbing), **R28** (poll the gamepad once per frame), **R29** (EffectsManager
budget comment says "rolling window", implements a fixed one).

**R16** (promote balance magnitudes into the registry) is **superseded**: a verifier refuted the round-2 restatement
of it. `EnemyDef` holding untunable per-species stats while `GameParams` holds tunable global `zombie*` values is
not "two homes by an unstated rule" — both files state their charter, and the split is deliberate. If per-species
tuning is ever wanted, the answer is a `Record<string, EnemyParams>` axis beside `GameParams`, not more
zombie-prefixed globals.

---

## 4. Looked at and deliberately rejected

Recording these so they aren't re-litigated. Each was proposed by an analysis lens and killed by a verifier reading
the actual code:

| Claim | Why it was refuted |
|---|---|
| The light budget is a boot global fed by per-level data; the crystal pool is 2–6 short of its own wave | The shortfall is **deliberate rationing**, stated in four places (`lend()` returns null, callers degrade; every pooled light costs per-fragment math even parked). Not a defect. |
| Two time channels — countdowns read raw `dt`, not `sim.now` | False. `sim.tick(dt)` accumulates *the same clamped dt* every system receives. One timeline. The clock's mandate was timestamps, not durations. |
| `CombatSystem` is the bus's only subscriber hub, so policy holds references to presentation | Misquoted the file's charter: the cited lines are the caption of the PRODUCERS half of a deliberately two-part file. |
| LOS is answered from the feet, the bolt from the hand — two implementations | Both call the **same** helper with the same threshold. The foot/hand offset is real and immaterial. |
| Re-dressed bodies restore limbs while ground chunks stay | Inverted by `corpses.ts:103` — the conclusion doesn't follow. |
| Ricochet/piercing have no seam in the bolt resolver | Accurate, but **not a defect** — by its own admission "nothing here is wrong today". It's a prediction that future work will be larger than its label. Noted in R22's carry-over instead. |
| Per-species magnitudes have two homes | See R16 above — the split is documented and deliberate. |

---

## 5. Recommended order

1. **T2-2 — finish the room/run seam** (`Horde.despawnAll`, `WaveController.reset`, `charge = 0` in `cancel`).
   It is the prerequisite for milestone 5 and the one item where the *staged* half is actively misleading: the seam
   looks ready and would corrupt room 2's floor if used today.
2. **T2-1 + T2-3 — give the arena an owner and make its perimeter real** (one refactor: `buildArena` returns the
   room, perimeter goes into the `CollisionWorld`, derived bounds collapse into the Arena object).
3. **T2-5** — the stage field + stagger validation. Small, and it removes a silent-degradation trap from the exact
   surface (`WaveDef` authoring) that milestone 4/5 will be editing constantly.
4. **T2-4** — `radius` onto `EnemyTarget`, before the first boss.
5. Tier 3 opportunistically, when touching the area. **T3-1** and **T3-3** are five-minute fixes.

Milestone 3 (XP/levels/upgrade picker) needs **none** of the above. Three of GAME.md's five upgrades are already
`system.setBase` writes against the modifier layer; the fourth and fifth (ricochet, piercing) want R22's
`{at, normal, t}` and a per-bolt pierce budget in `projectiles.update` — new behaviour, but on a resolver that now
has one owner and a clean signature.
