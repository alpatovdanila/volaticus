# Material system — UI refinement pass (user feedback, apply after the PBR baseline settles)

Refines the material UI the PBR workflow built. Execute as ONE focused pass with
visual verification per item — this is preference-driven polish, done directly (not fanned out).
Baseline files: src/editor/main.ts, ui.ts, style.css, index.html (+ preview.ts/effects.ts for #6).

## Layout — main window
1. **Material picker → its own column**, immediately right of the Model-parts column (today it's the
   bottom-right "Materials" browser). Three columns in the right region: [Model parts] [Materials picker] … .
   Keep it searchable + category-grouped; thumbnails = active-res color map.

## Part chips (Model-parts selector)
2. Material **preview thumbnail bigger**, **top-aligned** within the chip.
3. **Hover reveals the material name** (tooltip/label on hover); **remove the material name line under the
   chip title** (declutter — the title stays, the material name only shows on hover).
4. Per-chip **material-apply options** (these are per-slot overrides on top of the material's defaults):
   - tiling **type** (tile | fit | stretch)  — existing uvMode
   - **repeats** dropdown (uvScale density)
   - **angle** (uvRot 0/90/180/270)
   - **UV projection map** (box | planar | sphere)  — per-slot override of the material's default projection
   - **tint** (per-slot tint override — see #8; overrides the material's default tint for THIS part)

## Geometry musher (craft) section
5. **Remove the quality presets** (science/military/villager/beggar). Keep only the **slider + number input**
   and the **subdivide selector**. (Slider must still span full 0..1 — the earlier "doesn't reach the ends"
   fix stays.)

## Effect material inheritance
6. When an effect inherits a material from a slot, **tint must inherit too** — currently the tint appears
   stuck / not carried. Fix the slot-inherit resolution (preview.ts fireBinding + effects.ts inherit path)
   so the debris/particle gets the slot's resolved material AND its resolved tint (material default tint
   combined with any per-slot tint override from #8). Verify by tinting a slot and firing its effect.

## Material editor (Material Manager)
7. **Open as an OVERLAY / modal**, not by replacing the main window inline. (Dim backdrop, close button +
   Esc; the entity editor stays mounted underneath.)
8. Rename **"tint" → "default tint"** in the material editor. This is the material's baseline tint; it must be
   **overridable per-application** via the part chip's tint (#4/#11) when the material is applied to an object.
9. **Hover hint on EVERY option** (short tooltip explaining what it does). **No dead options** — audit each
   control end-to-end:
   - **heightBump appears to do nothing** → either make it visibly affect the surface (bumpMap scale from the
     height map — confirm the height map is wired and bumpScale is large enough to see) OR remove it.
   - Verify roughness/metalness/normalScale/aoIntensity/emissive/opacity/cutout/doubleSided/flat/uvScale each
     produce a visible change in the preview; cut or fix any that don't.
10. **Fixed-light toggle**: a light that stays FIXED in world space while the preview model rotates, so the
    PBR (normal/roughness/metal highlights) is legible as the surface turns. Default on. (The current lights
    likely rotate with the scene or there's no rotation — add auto-rotate to the preview model + a fixed key
    light.)
11. **Skybox in the preview**: use `resources/skybox/sky_22_2k/sky_22_cubemap_2k/{px,nx,py,ny,pz,nz}.png`
    (6-face cubemap) as the material-preview scene background AND as the reflection environment so metals/gloss
    actually reflect something recognizable. (Equirect fallback: `sky_22_2k/sky_22_2k.png`.) Preview only —
    the entity editor keeps its plain background; do NOT make it scene.environment globally (r178 rule).
12. **Preview box UVs**: the generated chamfered/test box has **very dense UV on the seams** — dislike. Rebuild
    the preview box with clean, evenly-spaced planar-per-face UVs (or just use a smooth sphere + a plane, or a
    simple non-chamfered cube with proper box UVs). The point is a clean, readable material surface.
13. **UV projection map** selector when editing a material — sets the material's **default** projection
    (box | planar | sphere); the per-part chip (#4) can override it per application.

## Part chips — edit material from object tab
14. **Right-click the material preview** in a part chip → **context menu → "Edit material"** → opens the
    material-editor OVERLAY (#7) focused on that slot's material. Fast path from object editing into tuning
    the material that part uses. (Left-click keeps assigning/picking; right-click = context menu.)

## Base geometry smoothness (engine — procgeom.ts + factory.ts, small content bumps)
15. **Raise the pre-subdivide (pre-jitter) polycount of rounded primitives** so base shapes read smooth
    before any craft/sub pass:
    - Factory `buildGeometry` defaults: cylinder/cone radial segments and sphere segments — raise the
      defaults (cylinder currently `?? 20` is ok but cones `?? 16` / sphere height-segs are coarse; bump so
      silhouettes are round). Post generator `generatePost` radialSegs default (currently ~7) → higher
      (e.g. 12+) — logs/trunks are very faceted at 7.
    - Bump the explicit low `segments` in rounded content that reads faceted: barrel shells (segments 10),
      well ring (9), wood_log/post trunks, geyser column, bucket rings — raise to a rounder count.
    - This is BASE density (silhouette), independent of `sub` (which adds jitter-prep tessellation). Keep
      poly counts sane (these are still low-poly props — aim smooth-but-not-heavy, ~14–20 radial for hero
      cylinders). Re-check the wireframe/polycount readout after.

## Material create / clone / delete (material manager + dev API)
16. **Clone a material** from an existing one: a "Duplicate" action in the material editor/manager creates a
    new `inventory/materials/<newid>.json` copying the source's maps + tuning, with a fresh id (e.g.
    `<src>_copy`, or user-named), immediately selectable/editable. **Delete**: user-created materials are
    deletable (trash action). Needs a **delete dev API** (add `/__inv/delete` — POST path, safePath-guarded,
    materials/ only or general) since only read/write/list exist today. On delete, warn if any entity slot
    still references it (list the referrers; don't silently break — offer to proceed). Imported base
    materials (the 258) can be delete-guarded or allowed with a stronger warning — user intent is mainly
    deleting their own clones. Registry: handle a removed material file on poll (already deletes on missing
    path — verify the material map is included).

## ROUND 2 refinements (apply after round-1 sweep lands; these refine round-1 items)
17. **Preview shape selector** (material editor): pick which SINGLE shape the material previews on, and show
    ONLY that shape. Options: **ball/sphere (DEFAULT)**, wall (vertical plane), floor (horizontal plane),
    cube, cylinder. Replaces #12's fixed sphere+cube pair — one selectable shape at a time. (Keep the clean
    even UVs from #12 on each shape.)
18. **Overlay near-fullscreen**: the material editor overlay occupies almost the whole screen — margins ≤ ~30px
    (refines #7's modal — make it big).
19. **Fixed light SEPARATE from auto-rotate**: two INDEPENDENT toggles (refines #10 which coupled them). One
    toggles the world-fixed key light; the other toggles preview model auto-rotation. Each works on its own.
20. **Style the material search input**: the search box is currently UNSTYLED in BOTH the main-studio Materials
    picker AND the material editor overlay's material list. Style both consistently with the app's inputs.
21. **Material-list dropdown under the input** (material editor): place the material list/dropdown BELOW the
    search input, not beside it (it currently gets pushed to the screen edge).
22. **Chip material name = tooltip on PREVIEW hover only** (refines #3): do NOT reveal the name on chip hover;
    show it ONLY as a native tooltip (title attr) when hovering the material PREVIEW image specifically.
23. **Even bigger chip previews**: increase the part-chip material preview size further, beyond #2.
24. **Geometry options under the dropdown, in-chip**: move the geometry/craft ("musher") controls (craft
    slider+input + subdivide, from #5) to sit BELOW the material apply-options row within the same chip —
    vertical stacking, now that the 3-column layout gives each chip vertical room.

25. **Top bar rearrange**: REMOVE the logo + app name (the "VOLATICUS / inventory editor" brand block). Move
    the primary controls into the top bar as an icon-forward toolbar:
    - **Materials** (opens the material manager overlay) — add an icon to the button
    - **Wireframe** toggle — icon
    - **Lineup**
    - **Materials preset** = the material quality / resolution selector (the 1k/256/128 dropdown, reframed as
      a quality preset)
    Keep Save (and the dirty dot) + anything essential. Clean, compact toolbar.
26. **Selected-entity title to the bottom** (goes with #25's top-bar cleanup): move the selected item's
    title line (`#sel-title`, e.g. "tree_birch — Birch Tree") OUT of the top bar to the BOTTOM of the
    preview/viewport, next to the triangle/poly count readout (the wireframe tris count). Title + tris count
    sit together as a small status line at the bottom of the viewport.

27. **Alpha mask on a material**: let the user add an alpha/opacity MASK texture to a material in the material
    editor overlay — a texture picker to assign ANY resource texture as the mask (+ a clear button). Runtime
    (materials.ts): `material.alphaMap` = the mask (three.js uses its green channel; NearestFilter, NoColorSpace),
    combined with the existing tuning — `cutout` → `alphaTest` (hard edges, leaves/foliage) or `opacity<1` →
    `transparent` soft. Store the chosen path on the material (single user-provided path, resolution-independent,
    e.g. `maps.alpha` or `tuning.alphaMap`). Preview shows the transparency (checker backdrop or the skybox
    behind). Schema + validate the path exists. Use case: leaf/foliage cutouts, custom transparency shapes.

28. **Skybox in the MAIN editor viewport too**: apply the same sky_22 cubemap (#11) to the main entity-editor
    viewport (src/editor/viewport.ts) — replace the flat blue background with the skybox. CRITICAL: background
    ONLY (`scene.background = cubeTexture`); do NOT set `scene.environment` (r178 WYSIWYG rule — it would flood
    materials with IBL and break true color). Optionally feed the same cubemap to envmap.ts as the opt-in
    reflection env so metals reflect the sky consistently with the material editor, but material COLOR stays
    WYSIWYG (env only where envMapIntensity>0). Share the cubemap load with the material-preview loader.

29. **Upload own alpha mask from computer** (material editor alpha picker): the alpha-mask picker (#27)
    currently only lists existing resource textures. Add an **"Upload…"** option — a file input → read the
    image → POST to a NEW dev endpoint (e.g. `/__inv/upload`, base64 body, safePath-guarded, saves under
    `resources/user-textures/<name>.png`) → assign the saved path as the material's `alphaMap`. The uploaded
    file must persist as a real file (referenced by path, survives reload, `npm run check` sees it).
    **USE CASE (user's task): a CANOPY texture = a grass material + an alpha mask with HOLES** — recreating the
    old cutout-leaf/foliage look from the minecraft texture sets. The uploaded mask is a black/white holes
    image; grass material + that alpha mask + cutout (alphaTest) punches see-through gaps for tree canopies /
    foliage. Verify: upload a holes PNG, apply to a grass material, confirm the material renders with
    transparent holes (preview + on a tree entity's leaves slot). (Uploading other map types can come later —
    alpha is the ask now.)

30. **Import minecraft_ported textures as materials** (`resources/freestylized-textures/minecraft_ported/`):
    a FLAT set of ~1006 classic minecraft block textures, each `<name>.png` (color) + `<name>_n.png` (normal,
    1004/1006 have it) + `<name>_s.png` (specular). 58 are animated (have a `.png.mcmeta`). The user wants
    them listed alongside the freestylized materials in the picker, USING THEIR NORMAL MAPS.
    - New script scripts/import-minecraft.ts (or extend import-materials.ts): for each base `<name>.png`
      (exclude `_n`/`_s` suffixes AND any name with a `.png.mcmeta` sibling = animated frame-strip, skip those),
      write `inventory/materials/mc_<name>.json` (mc_ prefix — avoids any id collision + groups them):
      id `mc_<name>`, name title-cased, category `"minecraft"` (or keyword-derive leaves/planks/log/stone/wool/
      ore/… for nicer grouping). maps: color = `freestylized-textures/minecraft_ported/<name>.png`, normal =
      `<name>_n.png` if present; roughness/metallic/height/ao/emissive = null. These are SINGLE-resolution —
      replicate the SAME paths under the 1k/256/128 keys so the existing res-resolver + fallback works unchanged.
      tuning = defaults (pixel-art → NearestFilter already applies). SKIP `_s` for now (old project behavior was
      "_s ignored"; could later decode to roughness — note it, don't block on it).
    - Idempotent; preserve existing catalog + user tuning (don't touch non-mc_ files). npm run check must pass
      (all mc_ paths exist; color non-null; normal optional).
    - Picker: ~948 new materials — make sure they group under their category so they don't drown the freestylized
      ones; lazy thumbnails already. Verify a few (mc_oak_planks, mc_stone_bricks, mc_acacia_leaves) render with
      their normal map on the preview/an entity, and appear in the picker. Check normal ORIENTATION looks right
      (GL convention; if lighting looks inverted, flip green channel — the old HD1/HD2 `_n` maps worked as GL).

## ROUND 3 (user feedback after PBR+minecraft landed)
31. **Light control sliders in the main editor** (harsh shadows): after the skybox background (#28) the
    entity viewport's shadows read HARSH (bright busy sky bg + dark unfilled shadow, no fill light since env
    is WYSIWYG-opt-in). Add UI sliders (small panel or top-bar popover, persisted to localStorage like the
    matpreview prefs) controlling src/editor/viewport.ts lights: directional (sun) intensity, ambient/hemi
    intensity, shadow darkness/opacity (ShadowMaterial opacity) and/or a shadow on/off, optionally sun
    azimuth/elevation. Let the user soften the contrast. Keep neutral colors (WYSIWYG).
32. **Tiling type / count sometimes doesn't apply** (bug): changing a slot's uvMode (tile/fit/stretch) or
    uvScale (repeats) sometimes doesn't update the render. UVs are BAKED into geometry (factory applyUvTiling
    meters by world size), so a uvMode/uvScale/uvRot/uvProject change MUST trigger a full geometry rebuild —
    not just a material swap. Find why it's intermittent (cached geometry reused? rebuild not fired on that
    param? per-slot override vs material default race?) and make EVERY tiling change re-meter + show
    immediately. Verify: toggle tile↔stretch and ×1↔×4 repeatedly on a slot — density changes every time.
33. **Materials picker tiles collapse to thin strips** (real bug, user-diagnosed — NOT a stale tab): `.tex-tile`
    in the #mat-col picker renders as thin horizontal strips in the user's browser at scale (~1200 materials),
    though it measured square in the agent's browser — an environment/browser difference in how `aspect-ratio`
    behaves inside the overflowing grid. USER FOUND: removing `overflow:hidden` + `aspect-ratio:1/1` fixes it.
    Implement a BULLETPROOF square-tile technique instead of relying on `aspect-ratio`: the padding-hack
    (`.tex-tile::before { content:''; display:block; padding-top:100% }` with an absolutely-positioned img
    `inset:0; width/height:100%; object-fit:cover`) squares every tile regardless of browser. Verify square
    tiles in a TALL NARROW window at ~1200 materials (reproduce the user's condition).

34. **Exploded slots + persisted inheritance** (format evolution — the biggest since PBR):
    **Goal**: every shaped part gets its OWN slot (no implicit geometry grouping), with a persisted
    "inherit from" graph so the user can group manually. Every property inherits until changed; each
    override gets a reset back to the parent value. All in the entity JSON — survives reloads.
    - **Schema** (src/inventory/schema.ts): slot gains `"inherit": "<parentSlot>"`. A slot with `inherit`
      resolves every UNSET property (material, tint, uvMode, uvScale, uvRot, uvProject, flat) from its
      parent, recursively (chains allowed, cycles = validation error; a chain must terminate in a slot
      that has `material`). Own keys are overrides. New shared resolver `resolveMaterials(doc.materials)`
      → fully-resolved record; factory/preview/effects/editor/game ALL consume resolved defs (put the
      resolver in schema.ts or materials.ts — shared runtime, all three pages).
    - **Migration** (scripts/explode-slots.ts, run on ALL entities): for each slot referenced by >1
      node (or >1 face), keep the original slot as the GROUP PARENT (it may end up referenced by no
      geometry — that's fine, it's the group knob) and give each referencing node its own child slot
      `<nodeName>` (collision → `<nodeName>_2`; per-face maps explode to `<node>_<face>` only where the
      face slot was shared) containing ONLY `{"inherit": "<origSlot>"}`; rewrite node.material to the
      child slot. Slots already used by exactly one node stay as-is. Idempotent; stringifyPretty;
      npm run check green after (validator must accept parent slots with no geometry references).
    - **Editor UI** (ui.ts/main.ts): each chip gets an "inherit from [✓][slot dropdown]" row (same
      pattern as the fx chips). While inheriting: controls SHOW the resolved parent values, styled
      dimmed/ghost; changing any control writes that key as an override (persisted) and marks the
      control overridden with a small ↺ reset button beside it; ↺ deletes the key → back to live
      parent value. Unchecking "inherit" freezes all resolved values as own keys (standalone);
      re-checking re-binds (keeps existing own keys as overrides). Changing the PARENT slot's values
      still live-updates all non-overridden children (that's the manual grouping working).
      Chip list groups children indented under their parent (parent chip first, children after,
      slight indent + collapse toggle per group — houses have 30+ nodes, keep it navigable).
      Thumb shows the RESOLVED material; picker assign to an inheriting slot = a material override.
    - **Cross-systems**: fx slot-inherit (effects), tint resolution, uv metering, the game + level
      editor instance builds — all must use resolved slots (single resolver, no duplicated logic).
      Validation: inherit target exists, no cycles, chain terminates in a material; npm run check.
      FORMAT.md updated (slot inheritance section with an example).
    - **Verify**: crate/chest/bench exploded (crate: frame → 13 children); changing the parent frame's
      material retextures all 13; overriding one child's tint diverges just that part + shows ↺;
      reset returns it to live parent value; reload persists the graph; uncheck freezes; game +
      level pages render migrated entities identically to before the migration (visual diff).

35. **UV direction in 15° steps**: the uvRot ("angle") dropdown currently offers only 0/90/180/270. Offer
    the FULL circle in 15° steps (0, 15, 30, … 345) in BOTH places: the part-chip apply-options row and
    the fx-chip debris direction. Schema: relax uvRot from the 0|90|180|270 literal union to a number
    0–359 (validate multiple-of-15 is NOT required — accept any, the dropdown just offers 15° steps);
    update the TS types (SlotInfo/FxTextureInfo/effectRef uvRot: number). Runtime already rotates via
    the uv-transform (degToRad — arbitrary angles work); confirm rotation is around the texture center
    for non-90° angles (center 0.5/0.5 is already set) and that effects inherit passes the angle through.
    Verify: a 45°/15° rotation visibly angles the grain on a plank slot + on inherited debris.

36. **"Hide MC textures" checkbox in the material picker** (#mat-col): a small persistent checkbox
    (localStorage) under the search/category controls that filters out all mc_* materials from the
    grid AND from the category dropdown counts. Default: unchecked (mc visible). Also respect it in
    the material-manager list and the alpha/texture pickers IF trivial — primary target is the main
    picker. Verify: toggle hides/shows the ~959 mc_ entries instantly, persists across reload.

37. **Right-click materials in the PICKER too**: right-clicking a tile in the #mat-col Materials picker
    opens the same context menu as the chip preview → "Edit material" opens the manager overlay focused
    on it. (Left-click keeps assigning.)
38. **"Show in picker" context option on chip previews**: the chip material-preview right-click menu gets
    a second entry, "Show in picker" — it RESETS the picker's search box + category filter (+ un-hides MC
    if the target is an mc_ material and the hide-MC checkbox is on), then SCROLLS the picker grid to that
    material's tile and briefly highlights it (e.g. the .current ring or a flash outline). Mind the
    800-tile render cap: if the material isn't rendered under "all categories", select ITS category first
    so the tile exists, then scroll.
39. **Viewport pick scrolls the chip into view**: clicking a part in the 3D viewport (which already picks
    the slot) also scrollIntoView({block:'nearest'}) its chip in the Model parts panel — with 30+ exploded
    chips (item 34) the picked one must never be off-screen.

## Notes
- Skybox cubemap face order for three.js CubeTextureLoader: [px, nx, py, ny, pz, nz].
- UV projection (box/planar/sphere) already exists as a concept from the asset-review pass (node-level or
  material-level) — reuse it; box = dominant-axis planar per triangle, planar = top-down XZ, sphere = around bbox.
- Per-slot tint override + material default tint: slot tint (if present) wins; else material default tint; else none.
- Verify each item with __ed + __shot screenshots read; console clean; tsc + npm run check clean; all 3 pages boot.
