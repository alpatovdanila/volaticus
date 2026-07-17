---
name: engine-audit
description: Deep architectural audit of the Volaticus game runtime (src/game, src/lib) — judges the custom engine on separation of concerns, single source of truth, coupling/cohesion, fragility and extendability, and stress-tests it against the planned roadmap. Use when asked to review/audit/analyze the engine or game architecture, judge whether the foundation creates tech debt or barriers, or check whether a planned feature will fit. Not for game-design review and not for the inventory editor.
---

# Engine audit

Judge the technical state of Volaticus's custom "engine" — the game runtime. The point is always the same question: **does the current structure create barriers or tech debt for what comes next?**

## Scope

**In scope — the game runtime only:**
- `src/game/**.ts` — the whole runtime
- `src/lib/**.ts` — easing, hmr-scope, lighting, rng
- the shared seam the game imports from `src/inventory`: `effects.ts`, `factory.ts`, `gltf.ts`, `materials.ts`, `schema.ts` — read these **only as the game consumes them**

**Out of scope — do not analyze or report on:** `src/editor/**`, the inventory editor UI, `scripts/**`, `vite.config.ts` asset-pipeline internals, `resources/**`.

## Hard rules

**No markdown docs.** Do not read, grep, or cite any `.md` file — no `docs/*.md`, no `ARCHITECTURE_REVIEW.md`, no `GAME.md`, no `DD_NOTES.md`, no `CLAUDE.md`, no `README.md`. The whole value of this audit is a fresh opinion formed from the code. Code comments inside `.ts` files are in scope, but treat them as **claims to verify**, not as truth — this codebase asserts things like "single source of truth" in comments, and the audit's job is to check whether that is actually so.

**Technical only.** No game design, balance, fun, content volume, or product/monetization commentary. A missing feature matters only insofar as the engine would obstruct adding it.

**Do not report** "no tests", "no docs", "needs a README". The user does not care.

**Early-stage incompleteness is not a defect.** A hardcoded test level is fine if the seam is clean. "The feature isn't built yet" is never a finding — a blocker means the current *structure* resists it or must be undone.

**Be calibrated, not negative.** Name what is genuinely strong and should be left alone, with the same rigor as the problems. Precision over volume: a weak finding dilutes a strong one. The user is an experienced developer who wants the truth about their foundation, delivered directly.

**Cite `file:line` for every claim.** Read the actual files; never speculate about code you have not read.

## Judgement criteria

1. Clear separation of concerns
2. Single source of truth where viable
3. Low coupling, high cohesion
4. Tightly-packed responsibilities (no god objects, no anemic shells)
5. Overarching/composite features must not create unnecessary coupling
6. Fragility and extendability
7. Who does what — should it do that? should it delegate? does it?
8. Clear data/event flow; no dead loops; no fragile concepts

## The roadmap the engine must absorb without a rewrite

Use this as the stress-test set — it is what makes the audit concrete rather than a purity exercise. For each item, try to bolt it on and report where the engine resists.

- More enemy types (ranged, exploder, shielded, swarmer — genuinely different behavior)
- Different guns (burst, charge-up railgun, flamethrower, grenade launcher, homing)
- Multiple ults, selectable at run start
- Progression of base stats (armor, upgrades) — persistent, between runs
- In-run progression: pick an upgrade on each level-up; upgrades stack
- Bosses (unique multi-phase behavior, huge HP, adds, healthbar, not poolable)
- Multiple rooms per run, each heavily different: lighting, textures, objects, waves, size
- Deliberate wave control: repeating, overlapping, per-type proportions, scripted sequences
- Cover, possibly destructible
- Two currencies (gold, rubies) — drops, pickups, between-run shop, persistence
- Possible physics engine integration (ragdolls, knockback, grenades, debris)
- Per-run and global upgrades to locomotion, guns, ults, player modifiers (e.g. temporary shield)

## Method

Scout the tree inline first (file list, LOC, the composition root, the core seams), then orchestrate — the runtime is small enough (~4.7k LOC) that agents can read files in full.

1. **Map** — one agent per cluster, each reading its files in full and returning a structured map (what each module *owns*, the data flow, the load-bearing seams, candidate smells, genuine strengths). Useful clusters: boot/frame loop, player/locomotion, combat/registry, enemies/waves, presentation/event bus, world/level seam.
2. **Judge** — one agent per criterion above, verifying the map against real code.
3. **Stress** — one agent per roadmap item: walk the implementation concretely, name the seams that already hold, report blockers with evidence and the minimal structural fix, and grade difficulty (`drops-in` / `small-refactor` / `significant-refactor` / `structural-rewrite`).
4. **Verify** — adversarially refute every finding and every blocker; default to refuted unless the code plainly proves it. The most common false positive is "not implemented yet" dressed up as a structural barrier — hold that line strictly.
5. **Critic** — a completeness pass (which files did nobody read? what cross-cutting issue is only visible from the whole?) and a calibration pass (is the panel holding an early-stage solo codebase to an enterprise standard? what should be left alone?).
6. **Synthesize** — architecture map, a lead verdict with a per-criterion grade table, what's genuinely strong, surviving problems most-severe first, a roadmap-readiness table, and a prioritized fix order that says explicitly what to defer and what to leave alone.

## Second pass: merge the overarching concerns

**A flat findings list is never the finished product.** Once the report exists, run a second pass over it: do its separate points share a root cause that one generalization, abstraction, or centralization would close? If so, produce the next iteration of the document reorganized around the root causes, with the coincident findings merged under the change that fixes them.

**The constraint that makes this hard, and matters more than the merging itself:** do not over-generalize. When concerns *seem* the same but differ in the details enough that a unified mechanism would cause interface-analysis-paralysis — where every future use has to stop and negotiate how to express itself — they must stay separate. Naming the false merges is as valuable as finding the real ones, because the false ones are what a reviewer talks you into.

### Tests for a real merge

- **Root cause, not description.** Do the findings share a cause, or only a sentence that covers them?
- **Simpler merged than separate.** If the unified fix needs flags, options, or escape hatches to serve all its members, it is the paralysis case. Name the flags out loud — that is usually the whole argument.
- **Same pattern ≠ same class.** Two sites can both deserve the boot-sized-pool *shape* without sharing a base class. Reusing a pattern is cheap; forcing shared code between things with different lifetimes or cardinalities is the over-abstraction.
- **Prefer "no new abstraction".** The strongest answer to "what new system fixes these?" is often *none — the codebase already has the right pattern elsewhere and simply didn't reuse it*. Reach for that answer whenever the evidence supports it, and name the in-repo precedent with `file:line`.
- **Calibrate to what exists.** A solo pre-alpha with one gun, one species and one room cannot justify a mechanism on symmetry, elegance, or "we'll probably need it". Only what exists or what is definitely on the roadmap counts.
- **A merge that yields N independent edits and a slogan is not a merge.** It may still be worth stating as a *rule* — just don't let the framing imply a mechanism should be built.

### Method

Orchestrate it symmetrically, because the failure modes run in both directions:

1. **Attack** each merge you believe is real — one agent per merge, trying to prove it only rhymes.
2. **Steelman** each merge you want to reject — one agent per merge, arguing forcefully *for* it, then ruling honestly on its own argument. A steelman that wins is a real finding; a steelman that fails is the rejection earned rather than assumed.
3. **Hunt** for clusters the analysis missed, and run a dedicated **over-abstraction guard** that asks the user's question ruthlessly of every proposed merge and names the weakest one.
4. **Synthesize** into: the diagnosis (root causes ordered by findings closed, each with the one change and its cost), the merges rejected and why, the residue that genuinely stands alone, and a fix order re-derived from the root causes rather than the flat list.

Findings that don't cluster stay in a **residue** section. Forcing them into a cluster to make the taxonomy tidy is the same error as over-abstracting the code.

## Places that reward attention

These are where the interesting architectural questions have historically lived. Look here, but do not limit the audit to them, and do not assume a past finding still holds.

- `main.ts` — the composition root and frame loop: what is it doing that it should delegate? Is there a session/run concept, or is the run welded to module load?
- `system.ts` — the base/params/modifier registry: is it genuinely the single source of truth, and does the modifier model actually absorb stacking upgrades + weapons + ults?
- `events.ts` — the fact bus: the subscriber graph, the borrowed-vector convention, re-entrancy, the closed union.
- `zombies.ts` — the largest runtime file: cohesive, or several systems fused?
- Lifecycle and teardown: what disposes, what leaks between rooms and runs, what is module-level singleton state.
- The light-count invariant and the shadow/post interaction: an engine-wide boot-order constraint worth judging for multi-room.
