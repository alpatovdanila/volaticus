# WebGPU + TSL migration plan

Target: **three r185** (latest published; r186 unreleased). Renderer: **`WebGPURenderer`**
from `three/webgpu` (auto WebGL2 fallback). Shaders: **TSL node materials** (no
`onBeforeCompile` on WebGPU). Post-processing: **node `PostProcessing`** (no
`EffectComposer`). This file tracks the phased execution.

## Constraints discovered (research)
- `onBeforeCompile` / `ShaderMaterial` / `EffectComposer` are **unsupported on
  WebGPURenderer** (even on its WebGL2 fallback). Must port to TSL.
- Node materials only render through `WebGPURenderer` → the renderer swap and the
  shader rewrites are coupled (swap first, then port shaders back one by one).
- Async init: `await renderer.init()` before first render (or `setAnimationLoop`).
- `renderer.shadowMap.autoUpdate=false` is a **no-op on WebGPU** — use per-light
  `light.shadow.autoUpdate=false` + `needsUpdate=true`. `object.castShadow` filtering
  at bake time still works → the two-light static/dynamic bake ports nearly verbatim.
- `shadow.intensity` is now first-class (per-light [0,1]).
- WebGPU MSAA = `antialias:true` (samples 1 or 4 only; no 2/8). GPU-timer
  (EXT_disjoint_timer_query) is WebGL-only → rework via `renderer.trackTimestamp` or drop.
- `renderer.info`: `calls`→`drawCalls`. No `preserveDrawingBuffer` (screenshot rework).

## The 5 GLSL injections to port to TSL (the hard part)
1. `lib/lighting.ts` `patchShadowMask` — darken **indirect/IBL** by the shadow mask +
   global emissive lift. → `material.aoNode` (indirect multiply) + `material.emissiveNode`.
   The IBL-only look depends on this; **highest risk**.
2. `inventory/materials.ts` `applyParallax` — steep/POM march. → TSL `Fn()`+`Loop()`,
   `dFdx/dFdy`, `tangentViewFrame`, offset UV fed into every map node.
3. `editor3d/theme.ts` `makeThemeMaterial` / `makeLayerMaterial` — triplanar. →
   `triplanarTexture()` built-in. (editor3d = level.html, secondary app.)

## Phases
- [x] **Phase 0** — bump three 0.178 → 0.185.1 (+ three-bvh-csg 0.0.18); WebGL still. Verified rendering.
- [x] **Phase 1** — studio `WebGPURenderer` swap (viewport.ts + lighting.ts + matpreview.ts +
  effects.ts): async `init()` + `ready` gate, drop EffectComposer (context MSAA via `antialias`),
  GPU timer via `trackTimestamp` ctor flag + `resolveTimestampsAsync` → `info.render.timestamp`,
  `renderer.info.render.drawCalls`, drop global `shadowMap.autoUpdate` (per-light gate honored on
  WebGPU — verified in `ShadowNode.updateBefore`), WebGPU-native `PMREMGenerator` from `three/webgpu`,
  `shadow.map = null` (RenderTarget|null). **Verified**: spire renders on the WebGPU backend, ground
  cast-shadow works, HUD reads real gpu-ms. Parallax + IBL shadow-mask + emissive lift temporarily
  inert (onBeforeCompile is a silent no-op on WebGPU) — restored in Phases 2–3.
- [x] **Phase 2** — `makeCatalogMaterial` now builds `MeshStandardNodeMaterial` (legacy map props
  still honored). `patchShadowMask` ported to TSL: `aoNode = (aoNode ?? materialAO) · mix(1, mask,
  strength)` darkens the IBL by the combined shadow; `emissiveNode = (…) + materialColor·emissiveU`
  lifts it. **Shadow rework folded in (was Phase 5)**: lights are `castShadow=false`; explicit
  `shadow(sunStatic)·shadow(sunDynamic)` nodes render the maps (per-light autoUpdate/needsUpdate gate
  = the static/dynamic split, no duplicate built-in pass). Ground catcher → `MeshBasicNodeMaterial`
  reading the same shared mask. Consumers retyped via `EntityMaterial` alias (factory/merge/main);
  `isMeshStandardMaterial` guards in envmap/lighting now accept `isMeshStandardNodeMaterial`.
  **Verified**: shadow=0↔1 A/B toggles ground shadow + blade self-shadows on the body; emissive lift live.
- [x] **Phase 3** — `applyParallax` ported to TSL. A `Fn()` ray-marches the height field
  (`Loop`/`Break`, tangent frame from `dFdx/dFdy(positionView)` + `positionViewDirection`, N flipped
  to face the camera, adaptive layer count, optional POM last-two-layer lerp) → offset UV, fed into
  `colorNode`/`normalNode`/`roughnessNode`/`metalnessNode`/`aoNode` (mirroring the stock MaterialNode
  per-channel formulas via `materialReference` so tint/normalScale/aoIntensity stay live). aoNode
  composes with the shadow patch. **Verified**: stone_bricks_wall_03 shows flat straight-on, real
  protruding relief at grazing angle (correct, not inverted). 6 catalog materials use it.
- [x] **Phase 4** — matpreview.ts `WebGPURenderer` swap (done alongside Phase 1: async init + ready gate,
  deferred first `applyLights`). Second WebGPU context — needs a Material-Manager open to verify.
- [x] **Phase 5** — shadow static/dynamic rework: done as part of Phase 2 (explicit `shadow()` nodes,
  `castShadow=false`, single map render per light). `shadow.intensity` available if finer control wanted.
- [x] **Phase 6** — AA resolved to **hardware MSAA only** (`antialias: true`, 4×, always on, direct
  render). The node `PostProcessing` AA passes (SMAA/FXAA/SSAA) were built and tested but DROPPED: the
  scene `pass()` render target's depth is 1-sample while the MSAA context depth is 4-sample, and
  `copyTextureToTexture` rejects the mismatch (hundreds of `GPUValidationError`/frame) — a fundamental
  single-renderer conflict, and `renderer.samples` is read-only post-construction so off/msaa can't
  toggle the context live either. Render panel simplified to off/msaa (+ an honest note); the parallax
  MERGE crash found here (`materialReference` → undefined color uniform on a shared merged material) was
  fixed by binding parallax/layer factors via `uniform(mat.color)` etc. **Verified**: barrel (parallax +
  merge) renders crisp, zero validation errors, 60fps.
- [x] **Phase 7** — editor3d (level.html) migrated. viewport.ts → `WebGPURenderer` (async init gates
  the `setAnimationLoop`, `compileAsync` precompile). theme.ts triplanar ported to TSL: `makeThemeMaterial`
  uses the built-in `triplanarTexture` (grass/rock blended by `normalWorld.y` smoothstep); `makeLayerMaterial`
  hand-rolls a triplanar (built-in lacks the per-plane rotate+offset) → colorNode/opacityNode/roughnessNode.
  All e3d materials retyped `E3DMaterial = MeshStandardNodeMaterial` (editMaterial too). **Verified**: grid +
  axes render, a placed Box shows the grass-top theme, TransformControls gizmo + three-bvh-csg intact, no errors.
