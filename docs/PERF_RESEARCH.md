# Volaticus performance research — synthesis report

**Scope:** the editor (`src/editor`, `src/inventory`, `src/lib`) plus the shared rendering code that ships in the game (three r0.185 WebGPU/TSL). Every item below was independently re-verified against the code and measured inventory data. **[CONFIRMED]** = citations and measurements reproduced by the verifier; **[PLAUSIBLE]** = mechanism verified, magnitude unproven. Paths are repo-relative; a few `src/lib/lighting.ts` refs carry ~+20-line drift (noted by the verifier, same code).

## 1. Executive summary

The money is in four places. **(1) The editor renders ~60–66 identical frames per second forever** — idle, under the Material Manager modal, in hidden tabs — and re-renders the 2048² VSM shadow map during every light-slider drag; render-on-demand plus a handful of S-effort gates reclaim most of the GPU the editor burns. **(2) Every select/rebuild/lineup-enter pays its full shader compile at reveal**, because the "precompile" gate awaits an invisible root that three's projection skips entirely; the same rebuild path also recreates every material from scratch, and dispose-before-build zeroes three's refcounted pipeline caches, so every edit recompiles everything. **(3) Assets are 3–8× heavier than needed at every layer**: ~1.2 GB texture VRAM from uncompressed 1k RGBA8 PNGs, 218 MB of sidecar JSON that is float32 printed as 17-digit doubles plus triple-stored soup vertices, and a 70 MB EXR decoded synchronously on every boot — all bake-time fixes that transfer 1:1 to the shipping game. **(4) At game scale, batcher cost is proportional to total placements, not visible content**: per-instance frustum culling is permanently off, geometry is duplicated per placement, and batches are exact-fit (any mutation = full rebuild). Draw-call count itself is already solved (~62–71 render objects ≈ 0.2 ms) — the material-collapse wall is the *last* wall, not the first.

## 2. Quick wins (high value, S–M effort, ranked)

**QW1 — Fix the no-op shader precompile gate** [CONFIRMED] · high · S
Groups are set `visible=false` *before* `compileAsync` (src/editor/main.ts:479-481; lineup main.ts:1659-1662). three's `_projectObject` returns on invisible roots (three Renderer.js:3082, reached via :962-966), so zero pipelines are queued, the await resolves instantly, and the reveal frame compiles everything synchronously (Renderer.js:3771-3786) plus VSM depth pipelines the same frame (main.ts:486, 1669). Fires on every select, edit rebuild, variant cycle, and lineup enter; the identical staging pattern is the intended game load path.
**Win:** removes the ~100 ms–1 s reveal hitch (lineup: 64 distinct material appearances × main + shadow passes). **Fix:** compile detached-but-visible, passing `vp.scene` via the third arg already in use (sceneRef, Renderer.js:902-906), then attach. **Risk:** low — keep the detached group un-frustum-culled during compile.

**QW2 — Render-on-demand** [CONFIRMED] · high · M
A self-scheduling rAF loop **and** `setInterval(tick, 33)` both render whenever ≥15 ms elapsed — never "did anything change" (src/editor/viewport.ts:148-161, gate at :151); `frame()` unconditionally runs subscribers, effects, controls, and render (viewport.ts:235-256). Static content is the common case: 22 of 45 entities have no anims, and a clip-less AnimPlayer just re-applies the base pose each frame (src/inventory/anim.ts:152-160). MaterialPreview already has the pause pattern to copy (src/editor/matpreview.ts:92, 179-185).
**Win:** the single biggest GPU/battery lever — full frame cost (PBR + optional SSAA×2 + GTAO) at 100% duty while idle drops to ~zero. **Fix:** `needsRender` flag; invalidation sources all exist (OrbitControls change/damping, shake >0.001 at viewport.ts:244, effects/anim activity, shadow/HDRI/resize/fit). Screenshot path is safe — it force-frames (viewport.ts:473-479). **Risk:** missed invalidation → stale frame; keep a 1 fps heartbeat during bring-up. Prerequisite "did it move" bit is MP7 below.

**QW3 — Pause the viewport under the Material Manager modal** [CONFIRMED] · medium · S
`enterMgr` shows the fullscreen modal and resumes the preview but never pauses the main viewport, which has no pause API; `exitMgr` pauses only the preview (main.ts:2021-2048, 2108, 2121-2138; matpreview.ts:125-138, 179-185). Two live ~60 fps loops for the whole material-tuning session.
**Win:** halves GPU during a long-session workflow; one boolean + two call sites. Subsumed by QW2 but ship it first. **Risk:** ~zero — render once on resume; the mgr screenshot path force-renders (main.ts:2296).

**QW4 — Swap the default HDRI to the 1k sibling** [CONFIRMED] · high · S
Boot fetches and synchronously main-thread-decodes a 70,089,032-byte 4k EXR (`LIGHT_DEFAULTS.hdri`, src/lib/lighting.ts:107 → path at :69; loadHDRI :311-356; EXRLoader has zero worker usage) before the real sky/IBL exists (applyParams fired at viewport.ts:141). A 5 MB 1k sibling exists.
**Win:** ~65 MB + 1–4 s of blocking decode removed per boot (×2 once the manager exists). **Caveat (verifier):** PMREM output scales with input (PMREMGenerator.js:358) and for photographic entries the 4k equirect *is* the visible sky — pair 1k probes with a 2k LDR sky image (§5). **Bonus bug found:** the boot placeholder URL looks stale (src/editor/skybox.ts:12 points at `skybox/sky_22_2k/sky_22_cubemap_2k`; faces live in `resources/skybox/sky_22_2k/`).

**QW5 — Cache HDRIs per rig** [CONFIRMED] · high · S
Every switch re-fetches, re-decodes, re-PMREMs: fresh loader per call (lighting.ts:314), previous env/bg disposed (:323-324), only sun directions cached (:318), `THREE.Cache` never enabled. Stylized entries load BOTH a .hdr probe and a 4–15 MB PNG sky per switch (:335-354); once the manager has opened, everything happens twice on its second renderer (main.ts:1311-1318; matpreview.ts:166-168). 42 HDRIs listed (lighting.ts:46-79) — sky auditioning is a core loop.
**Win:** switch-back becomes instant for a few MB of VRAM (`Map<id,{envTex,bgTex}>`; keep PMREM cubemaps, LRU big backgrounds; optionally share the decoded equirect between rigs). Reusing the same texture object on switch-back also skips the per-swap render-object recreation (see the rejected tonemap claim, §6). **Risk:** cap cached backgrounds (33–45 MB each at 4k).

**QW6 — Gate shadow re-render / traverse / prefs-save on what actually changed** [CONFIRMED] · medium · S *(merges two findings)*
All light sliders wire `oninput` → `applyLightsEverywhere` → `vp.setLights` (main.ts:1362; viewport.ts:311-318) → `rig.applyParams`, which **unconditionally** calls `placeSun()+requestShadowUpdate()` (lighting.ts:404-405) — a 2048² VSM depth pass + two 12-tap fullscreen blurs (~100M taps; lighting.ts:208-211; ShadowNode.js:449-499) up to once per rendered frame for the whole drag, even for intensity/emissive/ao, which cannot move the sun. `setLights` also full-scene-traverses `applyFlatShading` (viewport.ts:364-377) and synchronously writes localStorage per event (viewport.ts:44-50), all duplicated onto the manager's second renderer while open (main.ts:1311-1319).
**Fix:** diff against `this.params`; shadow update only for hdri/rotation/shadowSoft/sun-or-shadow crossing 0 (visibility flips on either, lighting.ts:401); traverse only when `flat` changed; debounce prefs to `change`. **Risk:** ~none by construction.

**QW7 — POM: `Break()` instead of `Continue()`** [CONFIRMED] · medium · S
`MAX_STEPS=64` with post-hit `If(...){Continue()}` guards means all 64 iterations' bookkeeping always run; the angle-adaptive layer count needs ~8 head-on at default quality 24 → up to ~56 wasted iterations per POM fragment on exactly the fill-bound close-ups that already dominate (src/inventory/parallax.ts:26, 133-149, 115-117). TSL exports `Break` compiling to WGSL `break` (three.tsl.js:661; LoopNode.js:349). 9 of 52 in-use materials have parallax.
**Win:** strictly fewer iterations, identical results, keeps the live quality-slider design (§6). **Also:** trial implicit-LOD for the 5 final `.grad` map fetches at node top level where it's legal (src/inventory/materials.ts:401-415) — only delta is mip choice at parallax silhouettes; the in-loop height taps legitimately need `.grad` (parallax.ts:96-104).

**QW8 — Share the emissive/color patch nodes across materials** [CONFIRMED] · high-adjacent · S
`patchEmissive` assigns a **new** OperatorNode per material for `emissiveNode` *and* `colorNode` (lighting.ts:420-443 — verifier: both must be shared); node cache keys default to instance id (Node.js:470-474), hashed into `customProgramCacheKey` (NodeMaterial.js:426-438) — so byte-identical materials get distinct builder states, surviving only via WGSL-string dedup (Pipelines.js:186, 200).
**Win:** identical materials share builder states within a build; first half of MP1. **Risk:** low — the uniforms are already shared.

**QW9 — Absorb slot tints with `setColorAt`** [CONFIRMED] · medium · S
`materialKey` includes `m.color.getHexString()` (src/inventory/merge.ts:64) and tint is folded into `material.color` (materials.ts:341-343) — exactly 10 excess batches today (plaster_wall_01 ×8 tints, bark_11 ×3, metal_01 ×2). BatchedMesh has native per-instance color (`_colorsTexture`, BatchedMesh.js:1108-1122) that node materials sample automatically (nodes/accessors/Batch.js:80-88); tint is per-bucket = per-instance (sceneBatcher.ts:163-177).
**Win:** converts tint from a draw-call multiplier into a free channel before level art scales. PBR scalars stay in the key — they collapse nothing on current data (§6). **Risk:** editor pick/outline reads of the canonical color must switch to instance color.

**QW10 — Don't rebuild the entity on browse-only Manager close** [CONFIRMED] · medium · S
`exitMgr()` calls `rebuild()` unconditionally (main.ts:2136): dispose + up to 120 fresh materials (factory.ts:1257; house_family = 120 slots) + merge + compile gate + 2048² shadow re-render — even after pure browsing.
**Fix:** `catalogTouched` flag set in `setMgrTuning` (the single tuning writer, main.ts:1846-1861), mgrSave/create/delete; note tuning mutates the runtime catalog even unsaved (:1857), so set on *tune*, not save.

**QW11 — Sidecar I/O: fetch what's shown, in parallel, unwrapped** [CONFIRMED] · medium · S *(merges three findings)*
Selecting an entity downloads **all** variants serially (`loadBaked` await-in-loop, main.ts:193-216; sky_isle = 34.9 MB / 6 requests) and re-downloads on every re-selection (sel cleared, main.ts:384-390). Every `/__inv/read` wraps the file as `{content: string}` (vite.config.ts:74-81), so each megabyte is JSON-parsed twice (+45%; main.ts:197-204, 1599-1606). The lineup fetches 46.8 MB in a 45-step serial waterfall interleaved with build work (main.ts:1592-1607) — and its own comment proves geom.0-only suffices (main.ts:1595-1599).
**Fix:** fetch `geom.{variantIndex}` only (lazy-fetch on cycle); raw-body endpoint with mtime header (other wrapper callers exist: registry.ts:103, main.ts:145 — new endpoint or update all); kick lineup fetches off up front. **Win:** up to ~6× shorter select veil on the heaviest entities.

**QW12 — Batch the boot inventory fetch** [CONFIRMED] · medium · S
Boot fires 317 individual `/__inv/read` requests to move 0.56 MB (registry.ts:98; list filter vite.config.ts:62-72; per-request stat+read+stringify :74-82) ≈ ~53 six-connection waves — the veil is request overhead, not data. Add `/__inv/readAll`; `/__materials` already proves the pattern (vite.config.ts:142-163). Poll/write paths untouched.

**QW13 — Demote the 33 ms interval to a stalled-rAF watchdog** [CONFIRMED] · medium · S
Both pumps run permanently, deduped only by the 15 ms gate; the interval id is never stored so it can never stop (viewport.ts:148-161; same in matpreview.ts:133-138). At 60 Hz: ~3 extra off-vsync renders/s with phase resets; at 144 Hz the gate yields a 48 fps base plus injections → 15–21 ms jitter while orbiting. Interval-injected renders also double-count HUD samples because `Info.reset` runs in three's *internal* rAF (Animation.js:69-91, started at Renderer.js:825 — the comment at viewport.ts:238-239 is wrong about this).
**Fix:** interval ticks only when `now - lastRafT > ~100 ms`. Preserves the hidden-tab screenshot behavior the interval exists for (viewport.ts:146-148).

**QW14 — Delete uv2** [CONFIRMED] · low · S — best value-per-effort on the list
Provably unsampled: node-material aoMap samples `uv(texture.channel)` with channel = 0 (TextureNode.js:270-273; Texture.js:118; even channel 1 would read `uv1`, UV.js:11); nothing in src assigns `.channel`. BatchedMesh pools it physically: 8 B × 491,826 verts = 3.9 MB, ~20% of batch vertex memory (factory.ts:933, 944; merge.ts:184; BatchedMesh.js:387-397). Sweep the extra setters too (matpreview.ts:282, main.ts:1760) and stale comments (ui.ts:1014, materials.ts:362). One visual AO check after.

**QW15 — Gate `readGpuTime` to HUD cadence; keep timestamps out of the game build** [CONFIRMED] · low · S
`resolveTimestampsAsync` + closure/`.then`/`.catch` every frame (viewport.ts:254, 260-275) → ~30 extra `queue.submit`s/s + a permanently in-flight readback (WebGPUTimestampQueryPool.js:94-233) for a HUD that repaints 5×/s (:284) with EMA smoothing (:269), and it runs even with no `#perf-hud` (:279-280). Move under the 200 ms gate; skip when HUD absent. **Ship note:** `trackTimestamp: true` (viewport.ts:103) attaches timestampWrites to every render pass (WebGPUBackend.js:2274) — construct the game renderer without it.

**QW16 — Recalibrate the draw-call budget (docs + HUD)** [CONFIRMED] · medium · S
"Draw calls = distinct-material count" (sceneBatcher.ts:3-6) is not what executes: the WebGPU backend encodes one draw **per visible instance** (WebGPUBackend.js:1806-1834; Info.js:156-158) — the HUD's number (viewport.ts:296) is ~216 sub-draws, not ~62 render objects. Budget both: render objects ≈ distinct materialKeys (bounded, ~3 µs each), sub-draws ≈ visible instances (unbounded without per-instance culling, MP2). Split them in the HUD so regressions show.

**QW17 — arrayBatcher.ts: mark as superseded reference before anyone revives it** [CONFIRMED] · low · S
Zero importers (grep). Header motivates with ~120 batches ≈ 0.37 ms; real count is 61–71 → ~0.19 ms payoff, below the sortObjects tax at level scale. Latent bug: `pipelineKey` omits depthWrite (arrayBatcher.ts:35-37) yet the material copies it (:209); baked-in regressions: mipless Nearest sampling (:79-81), envMapIntensity hard-coded 0.3 (:210), no normal maps (:16-17). Update the header; gate revival on measured >0.5 ms render-object cost (~150+ visible distinct materials). Keep — it's the only worked TSL array-texture example (:214-221).

## 3. Medium projects

**MP1 — Cache entity materials across rebuilds** [CONFIRMED] · high · M
Every rebuild disposes then re-creates ~22–120 fresh `MeshStandardNodeMaterial`s (factory.ts:1257 → materials.ts:323-324, no cache — contrast decalCache :218-220; dispose first at main.ts:542 → factory.ts:1353-1358; 14 call sites). three evicts pipelines/builder states at refcount zero (Pipelines.js:274-306, 443-463; NodeManager.js:421-443), so every edit recompiles every unique structure. Measured: 1,008 slot materials for 64 distinct appearances (16× over-instantiation; house_family 120 → 9).
**Fix:** cache by `(materialId | tint | doubleSided | flatShading | POM)`; disposeEntity skips cache-owned. **Prereq:** move flash/wireframe mutations off shared instances (main.ts:325-337, 361). Pairs with QW8; also de-risks game spawn-time compiles. **Risk:** shared-instance mutation semantics + disposal ownership need a clear rule.

**MP2 — Turn on per-instance frustum culling** [CONFIRMED] · high · M — game-scale gate #1
`frustumCulled=false` **and** `perObjectFrustumCulled=false`, with a bring-up-bug comment; the escape hatch is never called (sceneBatcher.ts:154-157, 219-221). The entire batched world is vertex-shaded and draw-encoded every frame regardless of view: ~492k verts today; 500–2000 placements ≈ 5.5–22 M VS invocations/frame with zero view scaling — the first GPU wall for a real level.
**Fix:** root-cause the documented mis-culling bug, enable the flag. The per-instance sphere math is *already paid every frame* by the sortObjects path (BatchedMesh.js:1585-1614), so enabling is ~free CPU and strictly reduces GPU + encode. Update ordering is fine (main.ts:1672 → viewport.ts:240 before render :251).

**MP3 — Deduplicate geometry per placement** [CONFIRMED] · high · M — game-scale gate #2
`computeMergeBuckets` + `addGeometry` + `addInstance` run per *input* with no keying (sceneBatcher.ts:134-135, 163-166): N placements of a prop = N copies of its merged geometry. Projection: 500 placements × ~10.9k verts × 40 B ≈ 219 MB vs ~20 MB stored once, plus per-placement merge CPU at level load (merge.ts:143-194). Buckets are entity-local by design (merge.ts:117-121) so sharing is bit-identical; BatchedMesh natively supports many instances per geometry id. Per-instance tint rides on QW9.

**MP4 — Preserve indices through merge/batch** [CONFIRMED] · medium · M *(merges two findings)*
Every primitive goes through `toNonIndexed()` (merge.ts:152 — including a pure-waste `clone()` for already-soup inputs), groups are sliced as raw vertex ranges (merge.ts:83-96), and batches allocate zero index space (sceneBatcher.ts:152): 324,049 indexed verts become 491,826 (+52%) with no post-transform cache; the backend's `drawIndexed` path sits ready (WebGPUBackend.js:1822-1824).
**Win (verifier-corrected):** ~24% batch memory standalone (~40% only combined with QW14) and ~1.5× fewer vertex shades on this content (unique ratio ≈1.98 v/tri). Full payoff after the bake-side weld (§5). **Care:** BatchedMesh indexing is all-or-nothing (identity indices for soup buckets); slotRanges → index domain (currently has no consumer — verified); check flat-shading toggle.

**MP5 — GTAO: denoise at gtaoRes, un-inherit MSAA** [CONFIRMED] · medium · M
The scene renders once (good), but the denoiser owns no render target — its ~49 texture reads/px execute inlined in the final composite at full canvas resolution (viewport.ts:183-202, 251; DenoiseNode.js:102-141; RenderPipeline.js:121-151); `setGtaoResolution` only scales the AO march (viewport.ts:219-222; GTAONode.js:255-263 — which is actually ~36 depth taps/px, per verifier). And `pass()` with no options inherits `renderer.samples` (PassNode.js:766): with `aa='msaa'` (main.ts:61-64) the MRT scene pass runs 4× multisampled — the comment at viewport.ts:172-174 claiming otherwise is provably stale. Example at 1600×900 dpr2: ~282 M reads/frame ≈ 19 G reads/s at 66 fps.
**Fix:** denoise into its own gtaoRes target (or three's RecurrentDenoiseNode), pass `{samples: 0}`, fix the comment. Opt-in today (main.ts:55) but this chain ships in the game.

**MP6 — Chip panel: update, don't rebuild** [CONFIRMED] · medium · M
Every viewport click → `refreshSlots()` + `matPicker.refresh()` (main.ts:1196-1232; again from chip onPick :1124-1133): O(slots²) inherit-candidate chains (main.ts:1004-1016, 1063), full rig walk per slot (992-1000; house_family 120×128 = 15,360 visits), innerHTML wipe + ~21k elements (ui.ts:382, 474-479, 552-556), 260-tile picker rebuild (ui.ts:730-758), and `refreshSlots` runs twice per rebuild (main.ts:546 + 525). Toggle `.selected/.current` classes for pick changes; rebuild only on doc change; drop the duplicate call. Collapse state already lives outside the DOM (main.ts:988).

**MP7 — Static/animated batch split + a "moved" bit from the anim player** [CONFIRMED] · medium · M
`update()` calls `setMatrix` for every animated instance every frame with no moved check (sceneBatcher.ts:209-215), and `setMatrixAt` always dirties the whole *capacity-sized* matricesTexture (BatchedMesh.js:1074-1085, sized at :334-352). Today: 128 instances / 29 batches ≈ trivial; at scale one idle animated instance in a 4k-instance batch re-uploads ~262 KB/frame. Split batches static/animated per materialKey; have AnimPlayer report whether anything moved so idle entities skip writes (`setVisibleAt` already early-outs, :1162-1177). **The "moved" bit is also QW2's dirty flag and un-defeats idle detection.**
Related [PLAUSIBLE]: per-frame allocation churn — fresh Maps/offset objects per animated node per frame (anim.ts:32-44, 118-138; blends :46-59) and three `.filter()`s even when empty (effects.ts:325, 333, 351) ≈ ~20k allocs/s in lineup. Verifier: GC harm unproven (sub-ms scavenges likely) — do the moved-bit for QW2, treat structure reuse as opportunistic.

**MP8 — Batch headroom for a mutable world** [CONFIRMED] · medium · M
Exact-fit construction (`new BatchedMesh(items, verts, 0, mat)`, sceneBatcher.ts:152) + documented one-shot dispose-then-rebuild lifecycle (:73-74) vs the game's runtime destruction/despawn event model → one pickup collected = re-bucket and re-feed every placement (the 45-entity lineup already needs a budgeted 12 ms/frame loop, main.ts:1639-1646; multi-hundred-ms at 500+ placements). Pre-reserve headroom, despawn via `setVisibleAt`/`deleteInstance` (+`optimize()` — all exist in r185), rebuild only on level load. Pairs with MP3.

**MP9 — sortObjects: measure, then choose** [CONFIRMED] · medium · S (a measured trade, not a free toggle)
SceneBatcher leaves `sortObjects` at default true (BatchedMesh.js:221; only dead arrayBatcher sets it false), defeating the early-out (:1522): every batch iterates all instances, sorts, and re-uploads its indirect texture every frame, plus a shadow-camera re-run on shadow frames (:1578-1678, 1682-1686). ~0.05–0.1 ms today; 5–10k instances ≈ 1–2 ms. **But** the sort is front-to-back (:21-25), feeding early-z on a fill-bound renderer — A/B with the GPU HUD (viewport.ts:258-298) on a POM close-up; candidate policy: off for small batches, or pre-sort statics once.

*Opportunistic:* the lineup retains ~11 MB of freeable source-geometry heap after batching (main.ts:1670; only `batcher.group` is in scene, :1660) — precompute triCount (main.ts:367-378) and free; picking never touches lineup meshes (verified: `vp.pick` only ever gets `sel.built.meshes`, main.ts:1201-1202). [CONFIRMED] low · S.

## 4. Big bets

**BB1 — KTX2/BC7 compressed-texture pipeline + channel packing** [CONFIRMED] · high · L *(merges three findings)*
Everything is uncompressed 1k RGBA8 PNG + generated mips via `THREE.TextureLoader`, cached with zero eviction (materials.ts:175-207); zero KTX2/CompressedTexture anywhere in src. The used set (52 materials → ~225 unique maps, 200.8 MB on disk, 254/258 color maps at 1024²) gates the lineup reveal behind `whenTexturesReady` (main.ts:1662; per-entity :481) and holds ~1.2–1.3 GB texture VRAM; the full catalog references 1,430 unique files / 1,164 MB (~7.5 GB ceiling if browsed, since nothing evicts); the manager's second WebGPU device re-uploads everything it previews (matpreview.ts:95).
**Plan:** ETC1S for color/AO/rough/metal, UASTC for normals/height; channel-pack rough(g)/metal(b)/ao(r) into one map — three's classic slots read exactly those channels (mirrored at materials.ts:410-415), collapsing 3 fetches/bindings → 1. Expected: 4–8× VRAM (lineup → ~330 MB), worker transcode instead of main-thread-adjacent PNG raster, 1 B/texel bandwidth on the fill-bound close-ups. **Risk:** BC blocks vs the crisp NearestFilter pixel-art look (materials.ts:195) — needs art signoff; colorSpace wiring. **Editor stopgaps:** LRU-evict texCache; optional 512 editor-res cap; stagger uploads via `renderer.initTexture` under the veil.
**S-effort ridealong** [CONFIRMED]: per-KIND filter policy in `loadTexture` — kills the Nearest/`#lin` double-cache (~48 MB duplicated after one POM toggle; keys at materials.ts:175-207, POM normal loaded twice via :352 then :397/:404), fixes Nearest-filtered normals on all non-POM materials (against the file's own guidance, :176-179), closes the latent srgb-cache-key hazard (zero conflicting uses today, scanned), and reuses the GPU image for height analysis instead of a second fetch+decode (materials.ts:36-71 vs :388).

**BB2 — Binary geometry sidecars** [CONFIRMED] · medium→high · M
After §5's quantize/weld land: Float32 `.bin` + small JSON header, glTF-style (FORMAT.md:199 already says so) → ~5× smaller than today (bush: 7.62 MB → 1.51 MB) with near-zero parse; loader is already numbers-in/numbers-out (factory.ts:816-825). Production must serve inventory statically anyway — `/__inv` is dev middleware only (vite.config.ts:53). Becomes high-impact the moment levels stream entities at load. Migrate via `GEOM_BAKE_VERSION` (main.ts:118).

**BB3 — The level-content architecture is MP2 + MP3 + MP8 as one program**: fixed geometry set per level, dynamic instance set, per-instance culling, headroom for spawn/despawn. Not new work — a sequencing commitment; all three touch the same code region (sceneBatcher.ts). Do it before the first real level, not after.

## 5. Asset pipeline (textures / HDRI / sidecars)

**The seam: a manifest-driven publish step** [CONFIRMED] · medium · S — `publicDir: 'resources'` ships everything verbatim (vite.config.ts:270): ~2.5 GB into dist, including 271 unreferenced PBR images = 316 MB — 251 of them `*_normal_dx_*` twins (296 MB) that *cannot* load (the catalog binds a single GL `normal` path, materials.ts:350-352) — and 400 sound files / ~87 MB referenced by nothing (inventory/sfx is empty; zero audio refs in entity docs). Walk inventory + HDRIS + sfx, copy only referenced files. This is the natural hook for every bake below; a manifest miss 404s loudly (`whenTexturesReady` settles on error, materials.ts:163-173).

**Weld at bake** [CONFIRMED] · high · M — subdivision and backface-folding output non-indexed soup by design (factory.ts:222-248, 852-878) and extractGeom stores it verbatim (:798-815), triple-storing shared vertices on disk and at runtime. Exact-float32 (pos, normal, uv) weld, measured: bush_flowering 49,536 → 16,358 verts (3.0×), sky_isle 5.5×, spire_tower 5.1×, tree_oak 2.1×; soup is 261,504 of the ~492k lineup pool verts. Format and loader already support indices (factory.ts:284, 821); the only soup consumer self-converts (box uvProject, :637-639). Bit-exact tuple matching preserves hard edges/seams by construction; bump `GEOM_BAKE_VERSION`, re-bake via the existing stale-UI flow. Compounds with MP4 and the quantize below.

**Quantize on save** [CONFIRMED] · medium · S — `Array.from(Float32Array)` + raw stringify (factory.ts:805-808; main.ts:130-133) prints every float32 as its float64 expansion (`0.20999999344348907` is literally in boomba.geom.0.json) ≈ 20 chars/number. Rounding pos/uv to 1e-4 and normals to 1e-3: bush 7.62 → 2.60 MB (2.9×), parse 11.8 → 7.4 ms; corpus 232 files / 218 MB → ~75 MB; loader untouched. Combined with weld: bush → ~0.9 MB. Caveat (verifier): cross-node seams round independently — sub-0.1 mm, invisible at meter scale; load-time weld never compares rounded positions (normals are stored; factory.ts:816-824 recomputes only when absent).

**Stylized skies: recompress** [PLAUSIBLE] · medium · S — 35 sky PNGs at 4096×2048 (dims verified), each ~44.7 MB VRAM as `scene.background` with mips, disposed and re-paid per switch (lighting.ts:337-354, 324). Verifier corrected the file stats: 0.66–19.5 MB, median 10.6 MB, total ~333 MB (not ~505 MB — hence PLAUSIBLE on shipping-size impact). 2048×1024 WebP ≈ 1–2 MB file / ~11 MB VRAM; the 512²-face boot placeholder (2.3 MB total) proves the style survives far less. Watch banding on gradients.

**HDRI sizing** — covered by QW4/QW5: ship 1k–2k probes for IBL; photographic sources today are 70–97 MB EXRs (autumn 97 MB, ticknock 95 MB); pair small probes with 2k LDR sky images where the equirect doubles as the visible background.

**Thumbnails** [CONFIRMED] · low · S *(merges two findings)* — picker tiles, manager rows, and slot chips all point `<img>` at full 1k color maps (ui.ts:419, 742, 833; main.ts:982-984/1068; vite.config.ts:158-159): up to ~300 MB and 260 × 4 MB decoded bitmaps browsing the catalog, bounded only by `loading="lazy"`. Dev-endpoint resize (`?thumb=96`, disk-cached under `.dev/` — dir already exists, vite.config.ts:10, 232-234), keyed by mtime.

## 6. Non-issues (verified — don't re-chase these)

**Frame loop**
- Perf HUD string/innerHTML churn is already 5 Hz-throttled (viewport.ts:284); per-frame part is two EMA multiplies.
- The VSM sun shadow really is cached (`autoUpdate=false`, lighting.ts:195/208-211) — idle frames pay zero shadow cost; only the slider *trigger* needed gating (QW6).
- Per-frame `setVisibleAt` is harmless — early-outs on unchanged values (BatchedMesh.js:1162-1171); lineup visibility pushes don't dirty the indirect buffer.
- The "mystery" extra rAF per renderer is three's internal Animation loop (Renderer.js:825) — info.reset + nodeFrame.update only; unavoidable in r0.185.
- Never-disposed effect material pools are deliberate — they prevent a 2–3 s re-link freeze on next spawn (effects.ts:52-58); keys are bounded.
- MaterialPreview while closed costs ~nothing (paused short-circuit, matpreview.ts:207-209).
- The 3 s registry poll is disciplined: hidden-tab skip, single-flight, interaction backoff, mtime deltas (registry.ts:243-298).

**Materials / shaders**
- 1,008 material instances cost zero per-frame CPU/GPU — hidden-layer sources fail the camera layer test and lineup sim graphs never enter the scene; draws track buckets (~64), not slots. Build/compile-time only (MP1).
- patchEmissive's per-fragment math is ~free and the emissive slider is a live shared uniform (zero recompiles) — its only real cost was cache-key fragmentation (QW8).
- Manager tuning drags don't recompile — uniforms live; structural flags flip `needsUpdate` only on real change (materials.ts:491-563).
- POM's fixed `Loop(64)` bound is the *feature* that makes the quality slider live (no recompile per notch) — the fix is `Break` (QW7), not a per-quality define.
- texCache ignoring srgb in its key is latent, not live — zero conflicting-role paths across all 260 docs; fix rides with BB1's filter policy.
- NearestMipmapLinear color maps mip correctly; anisotropy=1 is the deliberately cheap setting — don't "fix" it upward.
- envMapIntensity is live for node materials (EnvironmentNode scales IBL radiance + irradiance); the (1-roughness)² fade (materials.ts:468-469) works — one visual sanity check: it zeroes image ambient on rough non-metals.

**Geometry**
- Storing normals in sidecars is the right bytes-vs-ms trade (recompute = 21 ms/entity, 100+ ms lineup-wide vs ~25 ms parse saved) — quantize them, don't drop them.
- Zero legacy v5–v6 per-vertex `ao` arrays remain (all 232 sidecars scanned).
- JSON.parse isn't the bottleneck (~1.5 ms/MB, linear) — byte count is; fix size, not the parser.
- Disposal hygiene across rebuild/lineup/merge/bake/abort paths is solid (all paths verified) — don't hunt leaks there.
- keepSource "double geometry" is CPU-heap only — the hidden layer never renders, so never uploads; it's what makes picking/outline/shatter work.

**Batching / draw calls**
- Texture-uuid material keying genuinely works — one shared Texture per path + UVs baked into geometry collapse 1,008 slots to ~62–71 batches exactly. Don't "fix" it.
- PBR scalars / envMapIntensity in materialKey fragment nothing on current data — tint was the only slot-level splitter (QW9).
- Cached shadow re-renders are bounded by update frequency, not frame rate.
- 62–71 render objects ≈ 0.2 ms — the ArrayBatcher-style material collapse binds only past ~150+ visible distinct materials; it's the LAST wall (QW16, QW17).
- The budgeted async build machinery is load-time complexity only; aborts clean up correctly (verified).

**Editor / assets**
- crossValidate on commit is ~1–2 ms of linear ref-checking — fine as is.
- Slider/tint drags don't rebuild the entity — live uniform paths already exist; only UV-affecting commits rebuild, by design (UVs are baked into geometry).
- canShatter's per-build JSON.stringify is microseconds (~8 KB docs).
- The Manager's second canvas is not a background drain (starts paused, paused on exit) — only the *open* state doubles up (QW3).
- The post-build warmEffects compile is off the reveal path (fire-and-forget; pipeline-cache hits).
- 45 preview sims + batcher update per frame ≈ ~1,052 transform writes — sub-ms.
- Boot loads no geometry sidecars (list filters them) and no textures eagerly (lazy per built content; one remembered entity ≈ 12 MB avg) — boot's problem is request count (QW12).
- preloadSfx iterates nothing today (zero sample docs); the 87 MB sounds dir is a shipping-size issue only (§5).
- Mipmaps are configured correctly; disabling them would trade 33% VRAM for worse quality and *more* per-frame bandwidth.
- Per-slot texture clones / duplicate uploads were already eliminated; sun-direction extraction is strided + cached (~1 ms, once per HDRI); lineup parses only geom.0, not all 232 sidecars; ArrayBatcher's mipless repack is on no live path.

**Rejected claim worth remembering**
- *"Tonemap flip evicts and synchronously recompiles every pipeline"* — **false in r0.185 WebGPU**: tone mapping is a separate output pass (Renderer.js:1417-1431, 2500-2502), not baked into material shaders; the app's `material.version` bump traverse changes no cache key, so nothing is evicted — a flip costs one output-quad rebuild. The in-repo comment it leaned on is stale WebGL-era lore. The *salvageable half* is real: each HDRI/PMREM swap creates a new env texture → new cache node → render-object recreate + sync builder re-runs — which QW5's cache avoids on switch-back by reusing the same texture object.

## 7. Suggested order

1. **One afternoon of stopgaps:** QW3 (modal pause), QW4 (1k default HDRI), QW6 (slider gating), QW10 (Manager-close flag), QW13 (watchdog), QW15 (readGpuTime).
2. **QW1 precompile-gate fix** — the biggest feel win, and it validates the game's load path.
3. **QW2 render-on-demand**, building the "moved" bit from MP7 as its foundation.
4. **QW5 HDRI cache + QW8 shared nodes + QW9 setColorAt + QW14 uv2** — all small, all compounding.
5. **Bake round-trip:** quantize + weld (§5), bump `GEOM_BAKE_VERSION`, re-bake all; then MP4 indexed merge on top.
6. **Editor dev-loop:** QW11 + QW12 (I/O), MP6 (chip DOM), MP1 (material cache), MP5 (GTAO).
7. **Before the first real level (BB3):** MP2 culling → MP3 geometry dedup → MP8 headroom → MP9 sortObjects experiment, with QW16's HUD split watching the numbers.
8. **Pipeline program:** manifest publish step (§5) → BB1 KTX2 + channel packing → sky recompress (§5) → BB2 binary sidecars.

---

## Addendum (post-research, same day)

Two items above were overtaken by live debugging right after the swarm ran:

- **The §6 note "the VSM sun shadow really is cached … idle frames pay zero shadow cost" is half-true.** The cache DESIGN is real, but three r0.185's WebGPU shadow system IGNORES `LightShadow.needsUpdate` while `autoUpdate=false` — the map silently never rendered (symptom: a giant uniform "shadow blob" covering the frustum footprint, since empty texels read as occluders). Fixed in `lighting.ts`: `requestShadowUpdate()` now PULSES `autoUpdate` for exactly one rendered frame (`settleShadow()` freezes it again after the render). QW6's gate-the-triggers advice still applies on top.
- **The `sun` intensity param no longer exists** — the sun is a pure shadow-caster (intensity locked 0; the HDRI does all lighting; the "shadows" darkness slider multiplies the shadow mask into albedo). QW6's param-diff list shrinks accordingly (hdri / rotation / shadowSoft / shadow).
