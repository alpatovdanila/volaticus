# VOLATICUS inventory format

One JSON file per item under `inventory/`. The filename (minus `.json`) **is** the id.
Folder decides the kind: `effects/` → effect, `sfx/` → sfx, anything else → entity.
`inventory/settings.json` is special — global settings: the active `texturePack` plus
`surfaces`, the named surface presets materials can pick (see Materials below):

```jsonc
{ "format": 1, "texturePack": "sapixcraft",
  "surfaces": {                     // roughness/metalness/env per preset; env = how much of the
    "matte":    { "roughness": 0.95 },                 // neutral environment map it reflects.
    "polished": { "roughness": 0.3, "env": 0.45 },     // Materials WITHOUT a preset get env 0 —
    "metal":    { "roughness": 0.45, "metalness": 1, "env": 0.8 },  // fully predictable color.
    "chrome":   { "roughness": 0.12, "metalness": 1, "env": 1 },
    "wet":      { "roughness": 0.12, "env": 0.5 } } }
```

Texture ids in content always stay canonical
(`vanilla/textures/...`); when another pack (e.g. `sapixcraft`) is active, lookups redirect
per-file to `<pack>/textures/...` and fall back to vanilla for files the pack doesn't have —
so switching packs can never break content.
`npm run check` validates everything (schema, node/anim/slot refs, cross-file sfx/effect refs,
texture existence, animated-texture warnings). The editor shows the same issues live.

Conventions: meters, Y-up, entity origin at ground-center. Texture ids are paths relative to
`resources/` (e.g. `vanilla/textures/block/oak_planks.png`). Rendering is pixel-art
(NearestFilter); UVs tile at 1 texture repeat per meter unless a material says `"uvMode": "fit"`
(whole repeats, never cut mid-motif) or `"stretch"` (exactly once).
Animated Minecraft textures (ones with `.png.mcmeta`) are frame strips — don't use them yet.

## Entity (`inventory/props|pickups|enemies|characters/*.json`)

```jsonc
{
  "format": 1,
  "id": "boomba",                 // must equal filename
  "name": "Boomba",
  "category": "prop|pickup|enemy|character|levelpart",   // editor grouping
  "behavior": "static|dynamic|destructible|pickup|container|character|player", // game logic archetype
  "tags": ["bomb"], "notes": "free text",

  "materials": {                  // named slots; primitives reference slots, the editor assigns textures to slots
    "shell": { "texture": "vanilla/textures/block/coal_block.png",
               "tint": "#f2a13c",        // multiplies (white texture + tint = flat color). THE source of
                                         // "same texture, different colors" — editor shows it as a color
                                         // swatch on every slot chip (white = off)
               "emissive": 0.7,          // 0..3, glows
               "cutout": true,           // alpha-test (leaves, sprites) — without it transparent texels
                                         // render BLACK. The editor auto-sets it when an assigned texture
                                         // has an alpha channel; a per-slot checkbox overrides either way
               "doubleSided": true,
               "flat": true,             // flat shading — the house low-poly look
               "surface": "metal",       // surface preset from settings.json (editor: dropdown per slot).
                                         // Supplies roughness/metalness/env; explicit values below override it
               "roughness": 0.85,        // default 0.85 matte; lower = shinier (prompt-authored fine-tuning)
               "metalness": 0,           // 0..1
               "noise": 0.5,             // subtle procedural surface grain (stone, rough wood)
               "opacity": 0.55,          // <1 = translucent, no depth-write (well water, glass)
               "uvMode": "tile|fit|stretch", "uvScale": 1,  // tile = repeats per meter; fit = whole repeats
                                         // rounded so motifs never cut mid-pattern; stretch = exactly once.
                                         // uvScale multiplies density in tile/fit
               "uvRot": 90 }             // texture direction: degrees 0–359 (editor dropdowns offer 15° steps)
    // HD packs (HD1/HD2) ship foo_n.png next to each texture — wired as a normal
    // map automatically when that pack is active. No tone mapping; lights are
    // neutral white so tints render true.
  },
```

### Slot inheritance (`"inherit"`)

A slot may declare `"inherit": "<parentSlot>"` instead of (or in addition to) its own keys.
Every property that is UNSET on the slot — `material`, `tint`, `uvMode`, `uvScale`, `uvRot`,
`uvProject`, `flat` — resolves from the parent, recursively (chains allowed). Own keys are
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
  (the editor's `proj: —` choice writes it on inheriting slots). It also blocks the catalog
  material's default `uvProject`. An ABSENT key defers (parent, then catalog default).
```jsonc

  "rig": {                        // tree of named nodes; names are the animation/prompting vocabulary
    "body": {
      "shape": "box|cylinder|sphere|capsule|cone|plane|cross|torus|mesh|plank|post|ring|arrow|star",  // omit shape = pure group
      "mesh": "craftpix/.../Stone_big_001.fbx",  // shape "mesh": external low-poly FBX, merged to one
                                  // geometry (craftpix packs are cm-scale — node scale ~0.003-0.01);
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
      "open": true,               // cylinder without end caps (hollow shells; pair with doubleSided material)
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
                                  // Jitter hashes ENTITY-space vertex positions with the shared variant seed,
                                  // so nodes that abut stay sealed (coincident vertices move together) —
                                  // seams only diverge when per-part "seed" values differ (see below).
      "seed": 812734502,          // jitter seed override for THIS node — written by the ⟲ regen inside each
                                  // part chip (Model parts panel; regen writes the SAME seed to every node of
                                  // the part, so sealed seams within a part survive regen). Mixed with the
                                  // variant seed, so variants stay distinct. Absent = the shared variant seed.
                                  // GENERATION IS ON-DEMAND ONLY: builds replay stored seeds verbatim —
                                  // the same entity renders identically every time, editor and game alike.
      "uvProject": "box",         // OPTIONAL UV re-projection: 'box'|'planar'|'sphere'. Recomputed in
                                  // ENTITY space AFTER subdivision + craft jitter — box = dominant-axis
                                  // planar per triangle (crafted rocks, rubble), planar = XZ from above
                                  // (ground slabs), sphere = around the node's bbox center (boulders).
                                  // Replaces the shape's authored/tiled UVs; the material's
                                  // uvMode/uvScale metering still applies on top (tile = repeats/m,
                                  // fit = whole repeats over the projected extent, stretch = once).
                                  // Ignored on shape "mesh" (external models keep their atlas UVs).
                                  // Editor: "uv:" dropdown inside each part chip's craft panel —
                                  // written to every node of the part, like craft.
      "pos": [0, 0.36, 0],        // center of the primitive, in parent space
      "rot": [0, 0, 10],          // degrees
      "rotJitter": [0, 0, 4],     // variant: seeded random rotation, ± degrees per axis
      "pivot": [0, 0.1, 0],       // rotation point relative to center (e.g. shoulder at top of arm)
      "material": "shell",        // or per-face: { "side": "s", "top": "t", "bottom": "b", "front": ..., "all": ... }
      "hidden": true,             // default invisibility (revealed by a state's "show")
      "chance": 0.65,             // variant: node exists with this probability (seeded)
      "children": { ... }         // child positions are relative to this node's center
    }
  },

  "physics": { "body": "fixed|dynamic|kinematicCharacter",
               "collider": "auto" | { "shape": "box|sphere|capsule|cylinder", "size": [..], "radius": 0, "height": 0, "offset": [..] },
               // Explicit collider dims (size/radius/height/offset) are authored in the
               // entity's UNSCALED local units and SCALE WITH variants.scale at build time —
               // the collider always matches the rendered variant, same as "auto".
               "mass": 12, "friction": 0.5, "restitution": 0 },

  "props": { "health": 2, "walkSpeed": 1.3 },   // gameplay tunables, free-form per behavior

  "variants": {                   // a FIXED, STORED set of pre-generated results — never rolled at render
    "scale": [0.9, 1.1], "yawJitter": 8, "tiltJitter": 2, "tintJitter": 0.06,
    "oneOf": { "lid": ["lid_flat", "lid_ajar", "lid_broken"] }, // keep exactly one node per group, drop the rest
    "seeds": [862063942, 878841561, 828508704]  // THE variant set: each seed fully determines one static
                                  // result (oneOf picks, chance nodes, jitters, generated geometry).
                                  // The editor's 🎲 cycles them; world instances reference an index.
                                  // Regenerating the set = rewriting these numbers (on request only —
                                  // the editor's "⟳ seeds" button does exactly that, same count).
  },

  "states": {                     // presentation per lifecycle state; transitions live in behavior code
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

  "events": {                     // reactive one-shots fired by the game (hit, destroyed, collected, died, ...)
    "hit": { "sfx": "wood_hit", "anim": "wobble" },        // anim = one-shot overlay clip, state anim resumes after
    "destroyed": { "effect": "wood_break", "despawn": true } // despawn removes the entity (editor: hides + respawns)
  }
}
```

Bindings (state `enter`, `cues`, and `events`) accept: `sfx`, `effect` (plain id, or parameterized:
`{ "id": "wood_break", "slot": "planks" }` inherits that material slot's texture+tint+uvRot at fire
time — debris stays in sync when the object is retextured; or freeze explicit values with
`{ "id": ..., "texture": "...", "tint": "#...", "uvRot": 90 }`. Effect bursts marked `"inherit": true`
receive the params. The editor shows these as "fx" chips with an [inherit from → slot] control, plus
texture + direction pickers in explicit mode), `anim`,
`flash` (avoid — cartoon wobble anims read better),
`shatter` (the entity breaks into its rig pieces and they tumble away — death drama; pair with
`despawn`), `despawn`, and `byContext` — context-conditional overrides keyed
`"dimension=value"`. The game maintains the context (e.g. `surface` from the ground underfoot);
matching entries merge over the base binding. The editor shows a preview dropdown per dimension
it finds in the doc.

```jsonc
"0.03": { "sfx": "footstep",
          "byContext": { "surface=grass": { "sfx": "footstep_grass", "effect": "grass_puff" },
                         "surface=stone": { "sfx": "footstep_stone" } } }
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
    { "count": 6, "flipbook": { "pattern": "vanilla/textures/particle/explosion_#.png", "frames": 16 },
      "size": [0.9, 1.4], "grow": 1.6,  // grow = size multiplier reached at end of life
      "speed": [0.4, 1.1], "dir": "sphere", "life": [0.45, 0.7], "colors": ["#ffffff"] },
    // single static sprite (e.g. the villager angry cloud)
    { "count": 2, "sprite": "vanilla/textures/particle/angry.png", "size": [0.3, 0.36], "grow": 1.25,
      "speed": [0.5, 0.8], "dir": "up", "life": [0.55, 0.75], "colors": ["#ffffff"] }
  ],
  "flash": { "color": "#ffcc66", "intensity": 3.5, "radius": 8, "duration": 0.3 },
  "shake": 0.6 }                        // camera shake
```

## SFX (`inventory/sfx/*.json`) — sample files OR synthesized patch

Sample form (paths relative to `resources/`; one file picked at random per play — list several for variety):

```jsonc
{ "format": 1, "id": "footstep", "volume": 0.35, "pitchJitter": 0.12,
  "files": ["400 Sounds Pack/Footsteps/foley_footstep_gravel_1.wav",
            "400 Sounds Pack/Footsteps/foley_footstep_gravel_2.wav"] }
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

`variant` indexes into the entity's stored `variants.seeds` — placement PICKS a
pre-generated static result, it never generates. `overrides` are dot-path patches
onto the entity doc.
