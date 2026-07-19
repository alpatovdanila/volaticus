# Research: moving from transform-primitive animation to skeletal animation

*Status: research only — nothing here is implemented. 2026-07.*

## What we have today

AnimationsDriver = keyframe tracks on **rig-node transforms** (`pos.*`, `rot.*`, `scale`), applied to each
node's `outer` group by the anim player. Rendering-wise, the merge keeps every **animated node** as
its own "frame" bucket (one mesh per material under the node's `inner` group), and the SceneBatcher
pushes each frame's world matrix into its BatchedMesh instance per frame. Everything a clip touches
is therefore a **rigid chunk**: `leg_l` swings as one solid box around its pivot.

The felt limitation: no *bending*. A knee, wrist or ankle can only be faked by stacking more rigid
nodes (leg → foot → toe already exists on boomba), and the joints show seams/intersections instead
of deforming smoothly. No IK, no pose blending across joints, robotic silhouettes at high-motion
poses.

## The skeletal model, mapped onto this codebase

three.js gives us `Skeleton` (a tree of `Bone`s — which are plain `Object3D`s) + `SkinnedMesh`
(geometry with `skinIndex`/`skinWeight` vertex attributes; each vertex is transformed by up to 4
bones, weighted).

**The key insight: our rig tree IS a skeleton already.** Node names, hierarchy, pivots — a 1:1
mapping to bones. And because bones are Object3Ds, the *existing anim player can drive them
unchanged* (it writes `pos/rot/scale` on named nodes; bones have the same interface). The schema's
`anims` block needs **zero changes** for phase 1.

### Rigid skinning — the bridge that keeps everything

Build the entity exactly as today (per-primitive bake → per-node geometry), then instead of
parenting rigid meshes into groups:

1. create one `Bone` per rig node (same hierarchy, same pivots);
2. concatenate the primitives into ONE geometry per material (the merge already does this!),
   tagging every vertex with `skinIndex = its node's bone`, `skinWeight = 1`;
3. wrap in a `SkinnedMesh` bound to the skeleton.

**Visual result: pixel-identical to today.** Every vertex follows exactly one bone rigidly — same
transforms the group hierarchy applied. But the animation now flows through a skeleton, which is
the door to everything else.

> **Does this abandon per-primitive mesh building? No.** Authoring stays exactly as it is — I keep
> writing rigs as primitive trees in JSON, craft/sub/variants/decals all bake the same. Only the
> LAST assembly step changes for skinned entities: primitives fold into a skinned mesh instead of
> rigid groups. Props never change at all (see batching below).

### Smooth joints — the actual payoff (phase 2)

Once vertices carry weights, a joint region can blend between two bones: the vertices of a single
capsule "arm" near the elbow get `0.7/0.3`-style weights across upper/lower-arm bones → smooth
bending, no seams. Two ways to author it:

- **auto-weighting**: for a declared joint (`"blend": ["arm_upper", "arm_lower"]`), weight vertices
  by distance along the bone axis within a falloff radius — cheap to implement, good enough for
  our chunky style;
- **authored weights**: explicit per-node blend hints in the rig JSON (more control, more typing).

This is what makes *feet and hands* real: a foot becomes ankle+ball bones inside one shoe
primitive; fingers become 2-bone chains inside a mitten shape; the mesh bends instead of hinging.

## Costs, by subsystem

| Subsystem | Impact | Effort |
|---|---|---|
| Schema | none for phase 1 (`skinned: true` flag per entity); optional `blend` hints for phase 2 | tiny |
| Factory/bake | new final-assembly path: bone tree + skin attributes + SkinnedMesh (reuses the merge's concat) | ~1–2 days |
| Anim player | none — bones are Object3Ds with the same names; the player drives them as-is | ~0 |
| **Merge/BatchedMesh** | **BatchedMesh cannot skin.** Skinned entities can't join the cross-entity batcher — each costs its own draw(s) per material | the real trade |
| Shatter | needs "bake current pose → rigid pieces" before throwing chunks | ~½ day |
| Picking | three raycasts SkinnedMesh correctly (slower path; fine at our counts) | ~0 |
| GPU | skinning is a per-vertex matrix blend — negligible at our poly counts | ~0 |

### The batching trade, quantified

Draw calls are the currency of this codebase (the whole merge/batcher exists for them). A skinned
entity is 1 draw per distinct material (~3–8 for a character) instead of ~0.02 (its share of a
shared batch). With **≤ ~20 animated characters on screen** that's ≤ ~100 extra draws — acceptable.
The rule that keeps this safe: **skeletal is opt-in per entity** (`skinned: true` on enemies/
characters); props/scenery never opt in and keep the merged/batched path untouched. Hybrid, not
migration — nothing existing breaks, nothing re-authors.

## Recommended path

1. **Phase 1 — rigid-skinned pipeline** (~1–2 days): `skinned: true` → bones + rigid weights +
   SkinnedMesh assembly; anim player drives bones; shatter pose-bake. Visuals identical; proves the
   pipeline end-to-end. Fully non-destructive (a new assembly path beside the existing one).
2. **Phase 2 — smooth joints** (~2–4 days): auto-weight declared joints; author one character with
   bending knees/ankles/wrists; iterate the falloff until the chunky-cute style holds.
3. **Phase 3 — later, optional**: foot-planting IK helper, pose blending between clips
   (AnimationMixer crossfades), glTF import for externally-authored skinned meshes.

## Verdict

- Cost is **modest and contained** — the schema, authoring workflow, bake, variants, decals and the
  anim format all survive unchanged; the anim player itself likely needs *no* code changes for
  phase 1.
- The one genuine price is **losing cross-entity batching for skinned entities** — bounded by
  keeping skeletal opt-in for the few animated characters.
- Per-primitive authoring is **not** abandoned; it becomes the skeleton+skin generator's input.
- A phase-1 demo character (new entity, non-destructive) is a safe way to see it before committing;
  the *visible* payoff (bending joints) arrives with phase 2's weighting.
