# VOLATICUS PBR material system (design)

Replaces the flat "slot = one texture path + tint + surface preset" model with a
**named PBR material library**. `resources/PBR/` (258 stylized materials imported from
the freestylized-textures pack — each with color / normal / roughness / height /
metallic / AO / occasional emissive maps, single 1k resolution on disk) is the material
source. The migration is done: every entity now references a catalog material, and the
old block-texture packs are gone from disk (the legacy pack path survives only for the
level terrain).

## The pack, characterized (verified by scanning resources/PBR/)

- 258 material folders; families: ground_tiles(27), wood_planks(22), floor_tiles(22),
  bricks_wall(14), bark(11), roof_tiles(10), concrete_wall(10), wooden_roof_tiles(9),
  stone_wall(9), industrial_wall(8), cliff_rocks(7), tudor_wall(5), grass(5), metal(3)…
  — an ideal stylized set for the half-timbered buildings + nature props.
- Per-map coverage across the 258: color 258, normal_gl 254, roughness 254,
  height 241, ao 238, metallic 145, emissive 5. (flags_01/02 are color-only;
  a few use `.jpg` not `.png`.)
- **Filenames are inconsistent** — the importer must classify by keyword, not
  reconstruct paths. Observed color spellings: `color`, `baseColor`, `basecolor`,
  `Color`, `base`, `baseColo`(typo); AO: `ambientOcclusion`, `ambientocclusion`,
  `occlusion`, `occlussion`/`occulsion`/`ambientOcclussion`(typos), `Occlusion`;
  normal: `normal_gl`/`gl` (USE THIS — three.js is OpenGL convention) and
  `normal_dx`/`dx` (ignore); also `.jpg` and `.png`, and a stray `_4k_` in one
  roughness name. Resolution suffix placement varies (`_1k` vs `_1kwood_planks_19_`).
- **Single 1k resolution on disk** (the 64/128/256 tiers were dropped — only 1k ships,
  so the runtime resolution switcher was removed and the catalog `maps` are flat).

## Classifier (scripts/import-materials.ts)

Per file, lowercase the name (accept `.png|.jpg|.jpeg`), then pick the map kind whose
keyword sits **closest to the end** of the filename — the material id is at the front and
the map token at the back, so last-position-wins survives folder names that contain a
keyword (`metal_01`) and filename typos (`metal_pattren_02`) without per-name casing.
Keyword substrings per kind: normal→`normal`; roughness→`rough`; height→`height|displac`;
metallic→`metallic|metal`; emissive→`emissi`; ao→`occlus|occuls|occ|ambientoc|_ao`;
color→`color|albedo|diffuse|base`. Normals prefer the GL convention (`normal_gl`, what
materials.ts binds); a `_dx` file only fills the slot when no GL normal exists. A folder
with no color/albedo map warns and renders magenta until fixed.

## Material catalog

**Recommendation: one file per material** under `inventory/materials/<id>.json`
(consistent with the one-file-per-item + per-file hot-merge/parallel-edit
architecture; the importer writes all 258, the material manager edits `tuning`).
Alternative single `inventory/materials.json` is simpler to bulk-reset but a
parallel-edit hotspot — go per-file.

```jsonc
{
  "format": 1,
  "id": "bark_03",                 // == filename; == resources/PBR/<id> folder name
  "name": "Bark 03",
  "category": "bark",              // id minus trailing number, for grouping in the manager/picker
  "maps": {                        // ONE resolved path (or null) per kind — single 1k resolution.
                                   // The importer stores them so the runtime never reconstructs
                                   // paths (sidesteps the naming chaos). Relative to resources/.
    "color":     "PBR/bark_03/bark_03_baseColor_1k.png",
    "normal":    "PBR/bark_03/bark_03_normal_gl_1k.png",
    "roughness": "PBR/bark_03/bark_03_roughness_1k.png",
    "height":    "PBR/bark_03/bark_03_height_1k.png",   // stored but NOT bound (parallax removed)
    "ao":        "PBR/bark_03/bark_03_ambientOcclusion_1k.png",
    "metallic":  "PBR/bark_03/bark_03_metallic_1k.png",
    "emissive":  null
  },
  "tuning": {                      // what the material manager edits (importer writes these defaults)
    "tint": null,                  // multiply the albedo (null = untinted)
    "roughness": 1,                // scalar × roughnessMap (three.js multiplies), 0..2
    "metalness": 0,                // scalar × metalnessMap — default 0 (dielectric)
    "normalScale": 1,              // normal map strength
    "aoIntensity": 1,              // aoMapIntensity
    "emissive": 0,                 // emissiveIntensity (only bound if an emissive map exists)
    "opacity": 1,                  // <1 = transparent (depthWrite off)
    "cutout": false,               // alphaTest — leaves, flags
    "doubleSided": false,          // render both faces (a slot can still override per-application)
    "flat": false                  // flat-shading default (per-slot can still override)
    // optional, NOT written by the importer: "uvScale" (default tiling density, repeats/m),
    // "uvProject" ("box"|"planar"|"sphere"), "alphaMap" (single resolution-independent mask path)
  }
}
```

## Entity material slot — new shape

Old (embeds a texture): `"shell": { "texture": "vanilla/…/x.png", "tint": "#…", "surface": "polished", "uvScale": 4, "uvRot": 90, "flat": true }`

New (references a library material; keeps only GEOMETRIC/placement overrides):
```jsonc
"shell": { "material": "bark_03",      // library material id
           "tint": "#c8b48a",          // optional per-slot albedo multiply (over material.tint)
           "uvMode": "tile|fit|stretch", "uvScale": 4, "uvRot": 90,
           "flat": true }              // optional per-slot flat override
```
The PBR maps + roughness/metal/normal/ao + opacity/cutout come from the material.
`surface` presets are retired (the material carries roughness/metal/env). `texture`/
`surface`/`opacity`/`cutout`/`emissive`/`noise` leave the slot schema; `doubleSided` and
`flat` stay as optional per-slot overrides over the material's defaults (an open shell
needs its interior wall double-sided while the shared material stays single-sided
elsewhere). The slot also gains `inherit` (item 34, parent-slot chaining) and a per-slot
`uvProject`.

### Migration ("reset all textures in all existing items") — DONE

`scripts/reset-materials.ts` did the one-shot conversion: for every entity it replaced
each slot's old `texture` with a `material` id chosen by keyword from the old texture/
slot-name/tint so models didn't turn gray — wood/plank/log/bark → a bark or wood_planks;
stone/rock/cobble/brick → stone_wall / bricks_wall / cliff_rocks; leaf/needle/grass/
foliage → grass; metal/iron → metal; plaster/concrete/white → plaster_wall or
concrete_wall; roof → roof_tiles; else a neutral default — and dropped the retired slot
keys (surface/opacity/cutout/…), keeping tint/uv*/flat. The minecraft-ported refs were
later remapped to `concrete_wall_01`. Nothing references the old packs; the inventory
validates clean.

## Runtime (src/inventory/materials.ts)

`makeSlotMaterial` (→ `makeCatalogMaterial`) builds a `MeshStandardNodeMaterial` (WebGPU/
TSL) from the referenced catalog material: `map`(color, sRGB), `normalMap`(GL, linear,
`normalScale`), `roughnessMap`(linear, `roughness` scalar), `metalnessMap`(`metalness`),
`aoMap`(needs **uv2** — the factory sets `geometry.setAttribute('uv2', uv)`),
`emissiveMap`+intensity only where an emissive map exists AND `tuning.emissive > 0`.
Height maps are stored in the catalog (`maps.height`) but NOT bound — the parallax/bump
system was removed (to be rebuilt later). Per-slot `tint` multiplies `color`. **`uvRot`
no longer touches the material**: like `uvScale`, it is baked into geometry UVs by the
factory (`rotateGroupUVs`, applied after metering as `uv' = c + R(−θ)·(uv − c)` around
`c = (0.5, 0.5)` — the exact transform the shader applied for `texture.rotation = θ`,
so pixels are unchanged). Every slot therefore binds the SHARED cache textures; the
old per-slot rotated clones split merge.ts / BatchedMesh draw buckets on texture uuid
for visually identical slots. Env reflection stays opt-in via envmap.ts: a material
reflects when `metalness > 0 || roughness < 0.5`, and its `envMapIntensity` fades as
`(1 − roughness)²` so driving roughness→1 reads matte. Missing map → that channel
simply absent. Cache textures by resolved path (single shared `texCache`). Opacity/
cutout/doubleSided come from `tuning`; an optional `alphaMap` mask (single resolution-
independent path) binds as `material.alphaMap`.

## Editor changes

- **No resolution/pack dropdown.** The old pack dropdown and the briefly-planned
  resolution switcher are both gone — materials are single-resolution, so there is nothing
  to switch. A **Materials** top-bar button opens the Material Manager overlay instead.
- **MATERIALS picker** (was the Textures browser, right panel): thumbnails = each material's
  color map, grouped/searchable by category, **shorter** (the user wants it lower — reduce
  its flex height so the Model-parts panel gets more room). Click assigns `material` id to
  the picked slot. Old-pack textures no longer listed.
- **Slot chips**: `texture` name → `material` name; the **tint swatch + uv controls stay**;
  **remove the opacity slider + cutout checkbox** (now material-level). The gen row (craft
  dropdown + regen) is unaffected.
- **Material Manager** (an overlay/modal opened by the Materials top-bar button; the entity
  editor stays mounted underneath): left = material list grouped by category; center = a
  preview mesh lit by the current sun, textured with the selected material; right = tuning
  panel (tint, roughness, metalness, normalScale, aoIntensity, emissive, opacity, cutout,
  doubleSided, flat, optional uvScale/uvProject/alphaMap) writing the material file (dirty +
  save, hot-merge safe). This is where opacity/cutout now live.

## Dev API

- `/__materials`: returns the catalog (every material JSON) + its color-map URL (`thumb`)
  per material for picker/manager thumbnails. Editor uses this for the picker + manager.
  `/__textures` stays for the level terrain layers (migrate later).
- `/__mat/write` or reuse `/__inv/write` (materials live under inventory/materials/, so the
  existing inventory read/write/list already covers them — just teach the registry a
  `material` kind for `inventory/materials/*.json`).

## Validation

Extend the zod schema + `npm run check`: a `MaterialCatalogSchema`; entity slots now require
a valid `material` id that exists in the catalog (cross-ref like sfx/effect checks); every
referenced map file (plus the optional `alphaMap`) exists on disk; the retired keys
(texture/surface/opacity/cutout on slots) are rejected. Update docs/FORMAT.md's Materials
section to the new slot shape.

## Build phases — SHIPPED

All five phases are done; the material system is live in the studio.

1. Importer + catalog: scripts/import-materials.ts (classifier → 258
   inventory/materials/*.json from resources/PBR/), registry `material` kind, schema,
   /__materials, npm check.
2. Runtime: makeCatalogMaterial PBR build + uv2 in the factory + the env-reflection rule.
3. Migration: reset-materials.ts (every entity → material refs by keyword), retired slot keys.
4. Editor: MATERIALS picker, slot chips (opacity/cutout dropped), Material Manager overlay
   with live tuning + preview.
5. Verified: every entity renders with PBR materials, the manager tunes live, the picker
   assigns, nothing references the old packs, all three pages boot, tsc + check clean.
