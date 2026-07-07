# VOLATICUS PBR material system (design)

Replaces the flat "slot = one texture path + tint + surface preset" model with a
**named PBR material library**. The `freestylized-textures` pack (258 stylized
materials, each with color / normal / roughness / height / metallic / AO / occasional
emissive maps at 64/128/256/1k) becomes the material source; old packs
(vanilla/sapixcraft/HD1/HD2) are hidden from the picker (kept on disk only until
every entity is migrated off them).

## The pack, characterized (verified by scanning 1k/)

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
- Resolutions on disk: 64 / 128 / 256 / 1k. Editor exposes **1k / 256 / 128** only
  (skip 64). `_ORIGINAL_EMPTY_FOLDERS_delete_me` and `download-log_*.txt` are ignored.

## Classifier (validated — scripts/import-materials.ts will use this)

Per file, lowercase the basename, strip `.png|.jpg`, test in order:
`normal_?gl | (^|_)gl(_|$)` → normalGL; `normal_?dx | dx` → normalDX; else `normal`
→ normalGL; `basecolo|base_?color|(^|_)color(_|$)|(^|_)base(_|$)` → color;
`rough | (^|_)r(_|$)` → roughness; `metal` → metallic; `height|displac` → height;
`occl|occul|(^|_)ao(_|$)` → ao; `emiss` → emissive. Prefer GL normal; drop DX.
Validated against all 258: 1 unmatched (`ambient_occulsion` typo → add `occul`),
2 color-as-jpg (accept `.jpg`). Effective coverage after fixes: 258/258 color.

## Material catalog

**Recommendation: one file per material** under `inventory/materials/<id>.json`
(consistent with the one-file-per-item + per-file hot-merge/parallel-edit
architecture; the importer writes all 258, the material manager edits `tuning`).
Alternative single `inventory/materials.json` is simpler to bulk-reset but a
parallel-edit hotspot — go per-file.

```jsonc
{
  "format": 1,
  "id": "bark_03",                 // == filename; == freestylized folder name
  "name": "Bark 03",
  "category": "bark",              // name family, for grouping in the manager/picker
  "maps": {                        // RESOLVED paths per resolution (importer stores them;
                                   // runtime never reconstructs — sidesteps the naming chaos)
    "1k":  { "color": "freestylized-textures/1k/bark_03/bark_03_baseColor_1k.png",
             "normal": "…/bark_03_normal_gl_1k.png", "roughness": "…", "height": "…",
             "ao": "…", "metallic": null, "emissive": null },
    "256": { "color": "…_256.png", "normal": "…", "roughness": "…", "height": "…", "ao": "…", … },
    "128": { … }
  },
  "tuning": {                      // what the material manager edits (all optional, sane defaults)
    "tint": null,                  // multiply the albedo (null = untinted)
    "roughness": 1,                // scalar × roughnessMap (three.js multiplies)
    "metalness": 1,                // scalar × metalnessMap (0 if no metallic map)
    "normalScale": 1,              // normal map strength
    "aoIntensity": 1,              // aoMapIntensity
    "heightBump": 0,               // height → bumpMap scale (0 = off; low-poly can't displace)
    "emissive": 0,                 // emissiveIntensity (only if an emissive map exists)
    "opacity": 1,                  // MOVED here from per-slot (<1 = transparent, depthWrite off)
    "cutout": false,               // MOVED here from per-slot (alphaTest — leaves, flags)
    "doubleSided": false,          // MOVED here from per-slot
    "flat": false,                 // flat-shading default (per-slot can still override)
    "uvScale": 1                   // default tiling density (repeats/m); per-slot uvScale multiplies
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
The PBR maps + roughness/metal/normal/ao/height + opacity/cutout/doubleSided all come
from the material. `surface` presets are retired (the material carries roughness/metal/env).
`opacity`/`cutout`/`doubleSided`/`emissive`/`noise` leave the slot schema.

### Migration ("reset all textures in all existing items")

`scripts/reset-materials.ts`: for every entity, replace each slot's `texture` with a
`material` id chosen by keyword from the old texture/slot-name/tint so models don't turn
gray — wood/plank/log/bark → a bark or wood_planks; stone/rock/cobble/brick → stone_wall
or bricks_wall or cliff_rocks; leaf/needle/grass/foliage → grass; metal/iron → metal;
plaster/concrete/white → plaster_wall or concrete_wall; roof → roof_tiles; else a neutral
default (e.g. `plaster_wall_01`). Drop retired slot keys (surface/opacity/cutout/…). Keep
tint/uv*/flat. Nothing may reference the old packs afterward. `npm run check` must pass.

## Runtime (src/inventory/materials.ts)

`makeSlotMaterial` builds a `MeshStandardMaterial` from the referenced catalog material at
the ACTIVE resolution (`settings.textureRes`): `map`(color, sRGB), `normalMap`(GL, linear,
`normalScale`), `roughnessMap`(linear, `roughness` scalar), `metalnessMap`(`metalness`),
`aoMap`(needs **uv2** — factory must set `geometry.setAttribute('uv2', uv)`), `bumpMap`
from height at `heightBump` (skip real displacement — low-poly), `emissiveMap`+intensity
where present. Per-slot `tint` multiplies `color`. **`uvRot` no longer touches the
material**: like `uvScale`, it is baked into geometry UVs by the factory
(`rotateGroupUVs`, applied after metering as `uv' = c + R(−θ)·(uv − c)` around
`c = (0.5, 0.5)` — the exact transform the shader applied for `texture.rotation = θ`,
so pixels are unchanged). Every slot therefore binds the SHARED cache textures; the
old per-slot rotated clones split merge.ts / BatchedMesh draw buckets on texture uuid
for visually identical slots. Env reflection stays opt-in via envmap.ts
(a material with metalness>0 or a low roughness reflects — decide a threshold or a
per-material `env` tuning). Missing map → that channel simply absent. Cache textures by
resolved path (existing `texCache`). Resolution switch rebuilds all materials.

## Editor changes

- **Resolution dropdown** replaces the pack dropdown (`#pack-select`): options 1k/256/128,
  writes `settings.textureRes`, rebuilds. (`settings.texturePack` retired for the inventory
  editor; leave the level-terrain path for later.)
- **MATERIALS picker** (was the Textures browser, right panel): thumbnails = each material's
  color map, grouped/searchable by category, **shorter** (the user wants it lower — reduce
  its flex height so the Model-parts panel gets more room). Click assigns `material` id to
  the picked slot. Old-pack textures no longer listed.
- **Slot chips**: `texture` name → `material` name; the **tint swatch + uv controls stay**;
  **remove the opacity slider + cutout checkbox** (now material-level). The gen row (craft
  dropdown + regen) is unaffected.
- **Material Manager mode** (toggle like Lineup, new top-bar button): left = material list
  grouped by category; center = the viewport showing a preview sphere + a low-poly test
  cube lit by the current sun, textured with the selected material; right = tuning panel
  (tint, roughness, metalness, normalScale, aoIntensity, heightBump, emissive, opacity,
  cutout, doubleSided, flat, default uvScale) writing the material file (dirty + save,
  hot-merge safe). Resolution respected. This is where opacity/cutout now live.

## Dev API

- `/__materials`: returns the catalog (all material JSONs) + the active-resolution color-map
  URL per material for thumbnails. Editor uses this for the picker + manager instead of
  `/__textures`. `/__textures` stays for the level terrain layers (migrate later).
- `/__mat/write` or reuse `/__inv/write` (materials live under inventory/materials/, so the
  existing inventory read/write/list already covers them — just teach the registry a
  `material` kind for `inventory/materials/*.json`).

## Validation

Extend the zod schema + `npm run check`: a `MaterialCatalogSchema`; entity slots now require
a valid `material` id that exists in the catalog (cross-ref like sfx/effect checks); every
referenced map file exists on disk at the declared resolution; the retired keys
(texture/surface/opacity/cutout on slots) are rejected. Update docs/FORMAT.md's Materials
section to the new slot shape.

## Build phases (for the material workflow — run AFTER asset-review finishes)

1. Importer + catalog: scripts/import-materials.ts (validated classifier → 258
   inventory/materials/*.json), registry `material` kind, schema, /__materials, npm check.
2. Runtime: makeSlotMaterial PBR rebuild + uv2 in factory + resolution switching + env rule.
3. Migration: reset-materials.ts (all 69 entities → material refs by keyword), retire slot keys.
4. Editor: resolution dropdown, MATERIALS picker (shorter), slot chips (drop opacity/cutout),
   Material Manager mode with tuning + preview.
5. Verify: every entity renders with PBR materials at each resolution, manager tunes live,
   picker assigns, nothing references old packs, all three pages boot, tsc + check clean.
