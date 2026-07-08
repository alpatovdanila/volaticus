# VOLATICUS inventory format

One JSON file per item under `inventory/`. The filename (minus `.json`) **is** the id.
Folder decides the kind: `effects/` → effect, `sfx/` → sfx, `materials/` → material (the
named PBR catalog — see Material catalog below), anything else → entity.
`npm run check` validates everything (schema, node/anim/slot refs, cross-file sfx/effect refs,
texture existence, animated-texture warnings). The editor shows the same issues live.

Conventions: meters, Y-up, entity origin at ground-center. Resource paths are relative to
`resources/` (e.g. `PBR/bricks_wall_01/bricks_wall_01_color_1k.png`, `particle/explosion_0.png`,
`sounds/Footsteps/foley_footstep_carpet_1.wav`). Rendering is pixel-art
(NearestFilter); UVs tile at 1 texture repeat per meter unless a material says `"uvMode": "fit"`
(whole repeats, never cut mid-motif) or `"stretch"` (exactly once).

## Entity (`inventory/props|pickups|enemies|characters/*.json`)

```jsonc
{
  "format": 1,
  "id": "boomba",                 // must equal filename
  "name": "Boomba",
  "category": "prop|pickup|enemy|character|levelpart",   // editor grouping
  "tags": ["bomb"], "notes": "free text",

  "materials": {                  // named slots; a rig node references a slot, and each slot references a
                                  // PBR catalog material by id + GEOMETRIC/placement overrides layered on top
    "shell": { "material": "metal_01",     // catalog material id (inventory/materials/<id>.json). Supplies the
                                           // color/normal/roughness/metallic/ao maps AND the roughness/metalness/
                                           // emissive/opacity/cutout/doubleSided/flat from its `tuning` — see the
                                           // Material catalog section below. (The old per-slot texture/surface/
                                           // opacity/cutout/emissive/roughness/metalness keys are RETIRED —
                                           // a catalog material carries its own maps + tuning for all of that.)
               "tint": "#f2a13c",        // per-slot albedo multiply, ON TOP of the material's own tint (white
                                         // texture + tint = flat color). THE source of "same material, different
                                         // colors" — editor shows a color swatch on every slot chip (white = off)
               "flat": true,             // flat-shading override (else inherits the material's `tuning.flat`)
               "doubleSided": true,      // render both faces (open shells) — overrides `tuning.doubleSided`;
                                         // kept per-slot so a shared catalog material stays single-sided elsewhere
               "uvMode": "tile|fit|stretch", "uvScale": 1,  // tile = repeats per meter; fit = whole repeats
                                         // rounded so motifs never cut mid-pattern; stretch = exactly once.
                                         // uvScale multiplies density in tile/fit (× the material's own default)
               "uvRot": 90,              // texture direction: degrees 0–359 (editor dropdowns offer 15° steps)
               "uvProject": "box" }      // UV re-projection for this part: box|planar|sphere|none.
                                         // THE single source for projection — no node/catalog fallback.
  },
```

### Slot inheritance (`"inherit"`)

A slot may declare `"inherit": "<parentSlot>"` instead of (or in addition to) its own keys.
Every property that is UNSET on the slot — `material`, `tint`, `flat`, `doubleSided`, `uvMode`,
`uvScale`, `uvRot`, `uvProject` — resolves from the parent, recursively (chains allowed). Own keys are
**overrides**; **reset = delete the override key**, which falls straight back to the live
parent value. The single shared resolver (`resolveMaterials` in `src/inventory/schema.ts`)
feeds the factory, effects/preview, the editor chips and the game/level builds alike — there
is exactly one merge implementation.

```jsonc
"materials": {
  "frame":  { "material": "weathered_planks", "uvScale": 2 },  // GROUP PARENT — the group knob
  "post_a": { "inherit": "frame" },                            // everything from frame, live
  "post_b": { "inherit": "frame", "tint": "#b04030" }          // frame's material/uv, own tint
}
```

Rules and semantics:
- The inherit chain must terminate in a slot that has `material`; cycles and unknown targets
  are validation errors (`npm run check` + the editor's live issues).
- **Parent slots referenced by no rig geometry are legal** — after the explode-slots migration
  (`scripts/explode-slots.ts`) the original shared slot stays as exactly such a *group knob*:
  edit it and every non-overridden child updates live.
- Each shaped node references its own child slot (named after the node), so per-part
  overrides never affect siblings; deleting the override re-joins the group.
- `"uvProject": "none"` is an explicit override value meaning "keep authored/tiled UVs":
  an inheriting child can pin no-projection over a parent that sets `box`/`planar`/`sphere`
  (the editor's `proj: —` choice writes it on inheriting slots). An ABSENT key defers to
  the parent slot; if nothing in the chain sets it, there is no projection.
```jsonc

  "rig": {                        // tree of named nodes; names are the animation/prompting vocabulary
    "body": {
      "shape": "box|cylinder|sphere|capsule|cone|plane|cross|torus|mesh|plank|post|ring|arrow|star",  // omit shape = pure group
      "mesh": "models/stone_big.fbx",  // shape "mesh": external low-poly FBX (path relative to resources/),
                                  // merged to one geometry (many FBX packs are cm-scale — node scale ~0.003-0.01);
                                  // gets a normal material slot (the pack's texture atlas + flat + stretch)
      "size": [0.7, 0.6, 0.5],    // box/plank/arrow [w,h,d]; plane/cross [w,h]
      "tip": 0.2,                 // shape "arrow" ONLY: length of the sawn point, meters (default
                                  // min(h*0.9, w*0.45)). An arrow is a generated plank whose +x end
                                  // tapers to a point (signpost boards) — same meter UVs/craft as plank
      "points": 5,                // shape "star" ONLY: point count (default 5). Star = extruded n-point
      "innerRatio": 0.45,         // star in the XY plane (a point straight up, extruded along Z, spins
      "depth": 0.09,              // nicely about Y). innerRatio = inner/outer radius (default 0.45),
                                  // depth = extrusion (default radius*0.35); requires "radius"
      "radius": 0.3, "height": 0.7, // cylinder/post/cone/capsule(mid-section)/sphere(radius only)
      "radiusTop": 0.26, "radiusBottom": 0.31,  // cylinder/post frustum (barrel bulges, tapers)
      "segments": 10,             // cylinder/cone/sphere/post segments; cone 4 + rot y 45 = pyramid roof
      "segmentsY": 7,             // sphere ONLY: vertical row count (default segments/2). Bump when a
                                  // squashed boulder/cap shows a pronounced equator line — adds loops
                                  // in the vertical direction without densifying the radial facets
      "open": true,               // cylinder without end caps (hollow shells)
      "doubleWall": true,         // BAKE back-faces in as real geometry (duplicate tris, reversed winding +
                                  // flipped normals) so an open/thin surface reads from BOTH sides under a
                                  // SINGLE-SIDED material — which then MERGES with the part's other single-
                                  // sided same-material parts (one fewer draw). ~2× the part's tris (cheap:
                                  // the GPU is idle, draws are the cost). Use INSTEAD of a doubleSided slot,
                                  // not with it. For open shells (barrel body) this trades a draw for triangles.
      "tube": 0.05,               // torus ring thickness (torus lies flat, axis = Y)
      "thickness": 0.02,          // shape "ring" ONLY: wall thickness of the generated annular band
                                  // (outer+inner shell + top/bottom annulus caps — thin metal with real
                                  // thickness for barrel bands, bucket walls, rims; radius/radiusTop+
                                  // radiusBottom/height/segments/craft/seed work like post)
      "sub": 3,                   // subdivision levels BEFORE the craft jitter (each level: 4× triangles,
                                  // capped 4). Gives flat/coarse shapes enough vertices to deform — e.g.
                                  // a plane with sub 3 + craft 0.65 = lumpy tilled soil (garden_bed_large)
      "craft": 0.5,               // craftsmanship: 1 ≈ machine-perfect, 0 = crooked hand-hewn. Works on ANY
                                  // shape — seeded vertex jitter (jitter caps at ~0.6 m reference so big walls
                                  // stay subtle). Palette: rocks/ruins 0.5-0.65, mushrooms/foliage 0.6-0.72,
                                  // furniture 0.78-0.85, house walls 0.9, characters 0.85-0.93 (a whisper).
                                  // Shapes "plank"/"post"/"ring"/"arrow"/"star" are fully PROCEDURAL (uniform-density grids/
                                  // tubes + jitter; posts/rings carry side/top/bottom face slots, posts get
                                  // tree-ring caps) and default to craft 0.5 when absent. Also served at
                                  // /__geom?type=plank|post|ring|arrow|star&w&h&d (or radius/height/segments/
                                  // thickness; tip for arrow; innerRatio/points/depth for star)
                                  // &craft&seed. Geometry density is UNIFORM in all directions: side rings,
                                  // concentric cap rings and grid cells share one target edge length.
                                  // Jitter hashes ENTITY-space (BASE-pose) vertex positions with the node's
                                  // craftSeed, so nodes that abut stay sealed (coincident vertices move
                                  // together) ONLY when they share a seed — see craftSeed + seam-groups below.
      "craftSeed": 812734502,     // this part's craft-jitter seed — STUDIO-written, stored so craft is
                                  // reproducible (re-baking reproduces it exactly) and individually
                                  // re-rollable. First seeding gives every node ONE shared value (coherent
                                  // jitter, all seams trivially sealed). "⟲ craft" rerolls all; the part
                                  // chip's ⟲ rerolls just this part — AND its seam-group (any nodes that
                                  // share a base-pose vertex, e.g. welded frame corners), so a real seam
                                  // can't crack. GENERATION IS STUDIO-ONLY: the runtime replays baked geometry.
      // (UV projection is NOT a node field — it lives on the material slot; see materials.uvProject)
      "pos": [0, 0.36, 0],        // center of the primitive, in parent space
      "rot": [0, 0, 10],          // degrees
      "rotJitter": [0, 0, 4],     // variant: random rotation ± degrees per axis, rolled per variant into <id>.variants.json
      "pivot": [0, 0.1, 0],       // rotation point relative to center (e.g. shoulder at top of arm)
      "material": "shell",        // or per-face: { "side": "s", "top": "t", "bottom": "b", "front": ..., "all": ... }
      "hidden": true,             // default invisibility (revealed by a state's "show")
      "chance": 0.65,             // variant: node exists with this probability, rolled per variant into <id>.variants.json
      "children": { ... }         // child positions are relative to this node's center
    }
  },

  "physics": { "body": "fixed|dynamic|kinematicCharacter",
               "collider": "auto" | { "shape": "box|sphere|capsule|cylinder", "size": [..], "radius": 0, "height": 0, "offset": [..] },
               // Explicit collider dims (size/radius/height/offset) are authored in the
               // entity's local units; the collider always matches the rendered geometry.
               "mass": 12, "friction": 0.5, "restitution": 0 },

  "props": { "health": 2, "walkSpeed": 1.3 },   // gameplay tunables, free-form (the runtime reads these)

  // Geometry is BAKED by the studio, not generated at runtime. `variants` are the
  // bake RULES. Two sidecars, on independent clocks (so a craft edit never
  // reshuffles the arrangement):
  //   <id>.variants.json  — every entity has one (single-variant too). `count`
  //                          RESOLVED manifests: { parts: { <node>: { pos, rot } } }
  //                          — the parts present this variant (oneOf/chance already
  //                          resolved, rotJitter rolled into rot), no operators. The
  //                          composer + runtime read pos/rot straight from here — the
  //                          rig is never consulted for placement. Re-rolled by "⟳ variants".
  //   <id>.geom.{i}.json   — one per variant, a SELF-CONTAINED scene tree (glTF-
  //                          style): the rig's node hierarchy with each node's final
  //                          transform (pos/rot/scale/pivot), render fields (shape /
  //                          material slot / hidden) and baked geometry.
  //                          The runtime builds from this ALONE; the main file only
  //                          supplies material DEFINITIONS (by slot name) + anims (by
  //                          node name). Re-composed on a craft/sub edit, a reroll, or
  //                          "⟳ variants" — deterministically. Any runtime cycles them (🎲).
  // NOTE: variants derive their variety from LAYOUT (oneOf/chance/rotJitter). If
  // `count` exceeds the distinct layouts an entity can produce, some geom files are
  // identical — set count to the number of meaningful compositions.
  "variants": {                   // absent = a single baked composition
    "count": 3,                   // how many variant layouts/geom files to bake (default 1)
    "oneOf": { "lid": ["lid_flat", "lid_ajar", "lid_broken"] } // one node kept per group, per variant
  },

  "states": {                     // presentation per lifecycle state; transitions live in runtime/game code
    "initial": "sleeping",
    "sleeping": {
      "anim": "sleep",            // clip from anims (loops or holds last frame)
      "show": ["fuse_flame"], "hide": ["body"],   // visibility overrides while in this state
      "enter": { "sfx": "...", "effect": "...", "flash": "#ffffff" },  // one-shot on entering
      "cues": { "0.30": { "sfx": "..." } },       // fired at N seconds into the anim (each loop)
      "ambient": { "sfx": "boomba_snore", "every": [2.6, 5] },         // random-interval loop
      "despawnAfter": 0.05        // seconds until removal (editor: respawns for preview)
    }
  },

  "modifiers": {                  // combineable visibility overlays — NOT states. One active at a
    "happy": { "show": ["mouth_happy"], "hide": ["mouth"] },   // time; applied ON TOP of the current
    "hurt": { "show": ["eye_x_l", "eye_x_r"], "hide": ["eye_l", "eye_r"] }  // state's show/hide and
                                  // reapplied after every state change, so a face expression rides
                                  // along through walk/jump/anything. Runtime: EntityPreview
                                  // .setModifier(name|null); editor: toggle chips in the overlay;
                                  // game: ctx.player.setModifier / instance setModifier.
  },

  "anims": {                      // keyframe clips; values are OFFSETS from the authored pose
    "sleep": { "loop": true, "duration": 3.4, "tracks": [
      { "node": "body", "prop": "pos.x|pos.y|pos.z|rot.x|rot.y|rot.z|scale",
        "ease": "linear|sine|quadIn|quadOut|quadInOut|step",
        "keys": [[0, -12], [1.7, 12], [3.4, -12]] }   // [seconds, value]; rot in degrees, scale multiplies
    ]}
  },

  "events": {                     // reactive one-shots fired by the runtime (hit, died, collected, ...)
    "hit": { "anim": "wobble" },        // anim = one-shot overlay clip, state anim resumes after
    "died": { "effect": { "id": "wood_break", "slot": "planks" }, "hideGeometry": true } // death reaction (barrels, enemies, all): hideGeometry hides the mesh; the runtime owns actual despawn
  }
}
```

Bindings (state `enter`, `cues`, and `events`) accept: `sfx`, `effect` (plain id, or parameterized:
`{ "id": "wood_break", "slot": "planks" }` inherits that material slot's texture+tint+uvRot at fire
time — debris stays in sync when the object is retextured; or freeze explicit values with
`{ "id": ..., "texture": "...", "tint": "#...", "uvRot": 90 }`. Effect bursts marked `"inherit": true`
receive the params. The editor shows these as "fx" chips with an [inherit from → slot] control, plus
texture + direction pickers in explicit mode; OR a reserved `SCRIPT_EFFECT_*` id — currently
`"SCRIPT_EFFECT_SHATTER"`, a built-in that throws the entity's rig pieces apart (death drama),
resolved by the runtime instead of an inventory-effect lookup), `anim`,
`flash` (avoid — cartoon wobble anims read better),
`hideGeometry` (hide the entity's main mesh as part of a reaction, so only the effect/debris shows —
NOT instance removal; the runtime decides whether/when to despawn), and `byContext` — context-conditional overrides keyed
`"dimension=value"`. The game maintains the context (e.g. `surface` from the ground underfoot);
matching entries merge over the base binding. The editor shows a preview dropdown per dimension
it finds in the doc.

```jsonc
"0.03": { "sfx": "footstep",
          "byContext": { "surface=grass": { "sfx": "footstep_grass", "effect": "grass_puff" },
                         "surface=stone": { "sfx": "footstep_stone" } } }
```

## Material catalog (`inventory/materials/*.json`) — the named PBR library

Entity material slots reference these by `id`. One file per material: the importer
(`scripts/import-materials.ts`) writes `maps` with resolved paths under `resources/PBR/`,
and the studio's material manager edits `tuning`. Slots layer only geometry/placement on top.

```jsonc
{ "format": 1, "id": "wood_planks_20", "name": "Wood Planks 20", "category": "wood_planks",
  "maps": {                       // one texture path (relative to resources/) per kind, or null.
                                  // Single resolution — only the 1k maps ship on disk.
    "color":     "PBR/wood_planks_20/wood_planks_20_basecolor_1k.png",  // the one guaranteed channel
    "normal":    "PBR/wood_planks_20/wood_planks_20_normal_gl_1k.png",  // GL convention
    "roughness": "PBR/wood_planks_20/wood_planks_20_roughness_1k.png",
    "height":    "PBR/wood_planks_20/wood_planks_20_height_1k.png",     // linked but NOT bound (parallax removed)
    "ao":        "PBR/wood_planks_20/wood_planks_20_ambientocclusion_1k.png",
    "metallic":  "PBR/wood_planks_20/wood_planks_20_metallic_1k.png",
    "emissive":  null },
  "tuning": {                     // the baked surface look — an entity slot layers only geometry over this
    "tint": null,                 // #rrggbb base albedo multiply, or null
    "roughness": 1, "metalness": 0,   // scalar × the roughness/metallic maps (metalness defaults to 0)
    "normalScale": 1, "aoIntensity": 1,
    "emissive": 0,                // 0..4; the emissive map binds only when this is > 0
    "opacity": 1, "cutout": false,    // opacity < 1 = translucent; cutout = alpha-test (leaves/sprites)
    "doubleSided": false, "flat": false }
  // optional tuning keys: "uvScale" (default tiling density), "alphaMap" (one resource
  // path used as an opacity/cutout mask). Projection is per-ENTITY-SLOT, not on the catalog material.
}
```

## Effect (`inventory/effects/*.json`) — named gfx+sfx combo

Referenced from entity bindings via `"effect": "<id>"`.

```jsonc
{ "format": 1, "id": "explosion", "name": "Explosion",
  "sfx": "explosion_boom",              // or ["a", "b"]
  "particles": [
    // cube burst: chunky colored boxes (aspect makes planks)
    { "count": 26, "size": [0.08, 0.22], "aspect": [2.8, 0.45, 0.35], "speed": [3, 7.5],
      "geometry": "cube|plank",         // plank = procedurally jittered boards (wood_break debris)
      "inherit": true,                  // burst uses the texture/tint/uvRot passed by the caller's binding
      "dir": "sphere|up|ring",          // ring = horizontal outward scatter
      "offset": [0, 0.4, 0],            // spawn offset from the entity origin
      "gravity": -7, "drag": 1.2,
      "life": [0.4, 0.85], "colors": ["#ffd23c", "#3a3a3a"],
      "spin": 9, "fade": true, "delay": 0.06 },
    // flipbook burst: camera-facing sprite playing a frame sequence over its life
    { "count": 6, "flipbook": { "pattern": "particle/explosion_#.png", "frames": 16 },
      "size": [0.9, 1.4], "grow": 1.6,  // grow = size multiplier reached at end of life
      "speed": [0.4, 1.1], "dir": "sphere", "life": [0.45, 0.7], "colors": ["#ffffff"] },
    // single static sprite (e.g. the villager angry cloud)
    { "count": 2, "sprite": "particle/angry.png", "size": [0.3, 0.36], "grow": 1.25,
      "speed": [0.5, 0.8], "dir": "up", "life": [0.55, 0.75], "colors": ["#ffffff"] }
  ],
  "flash": { "color": "#ffcc66", "intensity": 3.5, "radius": 8, "duration": 0.3 },
  "shake": 0.6 }                        // camera shake
```

## SFX (`inventory/sfx/*.json`) — sample files OR synthesized patch

The `sfx` binding field is still part of the format, but `inventory/sfx/` is currently
EMPTY — there are no sfx files at the moment, so any binding that names one won't resolve
until the library is repopulated.

Sample form (paths relative to `resources/`, rooted at `sounds/`; one file picked at random per
play — list several for variety):

```jsonc
{ "format": 1, "id": "footstep", "volume": 0.35, "pitchJitter": 0.12,
  "files": ["sounds/Footsteps/foley_footstep_carpet_1.wav",
            "sounds/Footsteps/foley_footstep_carpet_2.wav"] }
```

Synth form (WebAudio, good for bespoke bleeps/hisses no pack file covers):

```jsonc
{ "format": 1, "id": "fuse_hiss", "volume": 1, "pitchJitter": 0.1,
  "layers": [
    { "type": "tone", "wave": "sine|square|triangle|sawtooth",
      "freq": { "from": 130, "to": 34 },          // or { "steps": [[0, 988], [0.08, 1319]] }
      "gain": { "from": 0.9, "to": 0 }, "curve": "exp|lin",
      "duration": 0.6, "start": 0 },
    { "type": "noise", "filter": { "type": "lowpass|highpass|bandpass", "from": 1400, "to": 90, "q": 1 },
      "gain": { "from": 1, "to": 0 }, "duration": 0.75 }
  ] }
```

## Level instances (future level editor)

```jsonc
{ "ref": "crate", "pos": [12, 0, -3], "yaw": 90, "variant": 2,
  "overrides": { "physics.body": "fixed", "props.health": 5, "states.initial": "aggro" } }
```

`variant` indexes into the entity's baked `<id>.geom.{i}.json` set — placement PICKS
a pre-composed static result, it never generates. `overrides` are dot-path patches
onto the entity doc.
