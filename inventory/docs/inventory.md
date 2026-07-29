# Inventory

The catalog of everything the game can spawn: one directory per item, holding a pointer doc
and its baked payload side by side. Raw sources live in `resources/` (gitignored, the raw
shelf — never written back into); bakers turn them into items; schemas are the single format
authority. Payloads are regenerable, so they are gitignored too — only the docs are tracked.

```
inventory/
  docs/       this
  schemas/    zod schemas — THE format definition per item type
  scripts/    bakers (self-sufficient: no imports from src/ or each other)
  skills/     Claude skills for item workflows (new-model)
  items/
    models/<id>/     <id>.json + index.baked.glb
    materials/<id>/  <id>.json + <id>.glb
    hdri/<id>/       <id>.json + <id>.ktx2
    effects/ sfx/    not reworked yet (empty)
```

Every doc is uniform: `{ format?, id, file }` plus item-type extras. `id` = snake_case of the
source name; `file` is doc-relative. Docs never carry what the payload can carry — tuning
lives in the payload where the format has a native home for it. Absent field = "not tuned",
never a hidden default. Validate at fill time and fail loudly; no fallbacks.

## Models — `schemas/model.schema.ts`, `scripts/bake-gltf.ts`

Source: `resources/models/<name>/` with `index.glb` (rigged, own textures) + one `.fbx` per
animation (basename = clip name; Mixamo rig). Bake:

```
npx tsx inventory/scripts/bake-gltf.ts resources/models/<name> inventory/items/models/<id>/index.baked.glb [--maxtex 1024]
```

The baker lifts skinned-mesh nodes to the scene root, bakes Lengyel tangents for
normal-mapped primitives, **drops every animation authored inside index.glb** (the sibling
FBX set is exactly the clip vocabulary), merges the FBX clips via rest-delta retarget
(rotations + hips height only — root motion never leaks), and prunes unused objects.
`--maxtex <px>` caps every embedded texture's longest side (4K source maps dwarf the mesh —
a knight goes 31MB → 6.7MB at 1024). Opt-in: it is the one lossy pass, and smaller maps pass
through untouched.
Output is validator-clean. Doc extras: `dismember` (per-part weights), `animationProfile`
(hand tuning, never invented by the baker).
The full flow is a skill: `skills/new-model/SKILL.md`.

`animationProfile.locomotion` = one `idle` clip + up to eight direction arms
(`front` required; `back`, `left`, `right`, `frontLeft`, `frontRight`, `backLeft`, `backRight`
optional). Each arm is a band list `[{above, clip, rate?, fade?}, …]` — `above` is the m/s
threshold, `rate` is a playback multiplier (tune by eye to kill foot-slip). The resolver
picks the direction nearest to the entity's local velocity **among arms actually declared**,
then the highest-`above` band the current speed clears; below ~0.05 m/s it falls to `idle`.
A rig that ships only forward clips profiles cleanly: everything degrades to `front`.

## Materials — `schemas/material.schema.ts`, `scripts/bake-material.ts`

Source: `resources/PBR/<name>/` PBR map sets (spelling drift is expected and handled — the
classifier pares the id prefix off filenames, then token-matches with color last/greediest).
Bake:

```
npx tsx inventory/scripts/bake-material.ts resources/PBR/<name> [out-dir] [--size 1024|512|256]
```

One GLB per material (default 512px): color + normal + ORM packed into three KTX2 textures
via `KHR_texture_basisu`, carried by a unit-quad mesh so loaders instantiate the material
and viewers preview it. AO/roughness/metallic share the ORM image (glTF-native: occlusion
reads R, metallicRoughness reads G/B). **Tuning lives in the GLB as real glTF factors**
(`roughnessFactor`, `metallicFactor`, `normalTexture.scale`, `occlusionTexture.strength`) —
edit factors, not the doc; a re-bake preserves them. Normal maps get their **green channel
negated at encode** (`NEGATE_NORMAL_GREEN`) — derivative-tangent shading needed a runtime
`normalScale.set(s, -s)` hack before; now the file is simply correct.

## HDRIs — `schemas/hdri.schema.ts`, `scripts/bake-hdri.ts`, `scripts/extract-sun.ts`

Source: any equirect image (`.exr`, `.hdr`, `.png/.jpg` — LDR is upconverted sRGB→linear at
white = 1.0). Bake:

```
npx tsx inventory/scripts/bake-hdri.ts <source-image> [out-dir] [--size 1024|2048|4096]
```

One KTX2 (UASTC **HDR** — BC6H-class on GPU, ~8bpp, zstd, mips, default 2048). Components
clamp at ~65k so the encoder never rescales into the `HDRScale` side-channel three ignores.

**Orientation contract**: equirects are stored **bottom-up** (zenith in the last rows —
three's `equirectUv` puts +Y at v=1). EXRLoader decodes bottom-up natively; HDRLoader and
sharp decode top-down and are flipped at decode. The proof is in the docs:

```
npx tsx inventory/scripts/extract-sun.ts [entry-dir ...]
```

writes `sun: [x, y, z]` (unit vector toward the dominant light, thresholded at 90% of peak,
sphere-vector centroid) into each doc — computed from the item's own ktx2 at bake time so
the game places a real sun without ever reading pixels. Skies with no concentrated bright
region carry **no** `sun` field. Since real suns point up, **a negative-y sun after any
rebake means a decoder changed its row order** — the field doubles as the orientation canary.

## The encoder

`scripts/basis/` vendors the official basis_universal wasm (`v2_10_final_snapshot`,
`basis_encoder.js` saved as **`.cjs`** — the project is `"type":"module"` and an ESM load
strips `module.exports`). It encodes LDR + HDR and transcodes (`KTX2File`), so bake-time
analysis can read its own outputs. Embind method names live in the **wasm**, not the js —
grep proves nothing; introspect at runtime. sRGB call is `setKTX2AndBasisSRGBTransferFunc`
(2.x rename).

## The open seam

The game engine still loads from pre-rework paths (`inventory-entity.ts` globs old
locations and reads `doc.model.src`; the material/hdri loaders predate the pointer docs).
That migration is the deliberate next step ("the loader pass") — until then `tsc` shows
exactly two known errors at the `doc.model` seam, and nothing in `src/` is to be touched
from inventory work.
