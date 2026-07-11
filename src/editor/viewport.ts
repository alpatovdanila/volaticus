import * as THREE from 'three'
import { WebGPURenderer, MeshBasicNodeMaterial, RenderPipeline, ShadowNodeMaterial } from 'three/webgpu'
import { positionLocal, normalLocal, vec2, vec3, vec4, float, pass, mrt, output, normalView, rtt, screenUV, uniform, mix, smoothstep } from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { setLevelEnvMap } from '../inventory/envmap'
import { setFlatShadingEnabled, configureKtx2 } from '../inventory/materials'
import { EffectSystem } from '../inventory/effects'
import { loadSkybox } from './skybox'
import {
  LightingRig,
  LIGHT_DEFAULTS,
  clampLightParams,
  HDRIS,
  type LightParams,
} from '../lib/lighting'

// re-exported so main.ts can keep importing these from './viewport'
export { HDRIS, type LightParams }

export interface PickResult {
  mesh: THREE.Mesh
  nodeName: string
  slot: string
  face: string
}

const LIGHTS_KEY = 'volaticus.lights'
// selection stroke width, in the part's local units (normal-space inflation of the
// inverted-hull shell). ~12mm reads as a thin rim on the ~0.5m props.
const OUTLINE_THICKNESS = 0.012

function loadLightPrefs(): LightParams {
  try {
    const raw = localStorage.getItem(LIGHTS_KEY)
    if (!raw) return { ...LIGHT_DEFAULTS }
    return clampLightParams({ ...LIGHT_DEFAULTS, ...(JSON.parse(raw) as Partial<LightParams>) })
  } catch {
    return { ...LIGHT_DEFAULTS }
  }
}

function saveLightPrefs(p: LightParams): void {
  try {
    localStorage.setItem(LIGHTS_KEY, JSON.stringify(p))
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export class Viewport {
  renderer!: WebGPURenderer // WebGPU (auto WebGL2 fallback); async-inited in the ctor
  private ready = false // renderer.init() resolved — gates the frame loop
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  root = new THREE.Group() // current entity lives here
  effects: EffectSystem
  onUpdate = new Set<(dt: number) => void>()

  private clock = new THREE.Clock()
  private raycaster = new THREE.Raycaster()
  private shake = 0
  private outlines: THREE.Object3D[] = []
  // perf HUD (bottom-left overlay): draw calls + tris + smoothed CPU render time.
  // The editor loop is throttled ~66fps, so CPU ms / draw calls are the signal.
  private perfHud = document.getElementById('perf-hud')
  private renderMs = 0
  private frameMs = 16
  private lastFrameT = -1
  private hudLastT = 0
  // GPU frame time: WebGPU has no EXT_disjoint_timer_query. renderer.trackTimestamp +
  // info.render.timestamp is the WebGPU path — wired below; -1 until first read.
  private gpuMs = -1
  // shared HDRI environment rig (IBL lighting). Studio persists params to
  // localStorage. Public so boot can chain rig.onHdriLoaded (effect warmup waits
  // for the env).
  rig!: LightingRig
  private lightParams: LightParams = loadLightPrefs()

  // supersampling factor on top of devicePixelRatio (SSAA) — live-appliable via
  // setRenderScale; MSAA is a renderer-creation option (opts.antialias) and needs a
  // page reload to change (the render panel persists + reloads).
  private renderScale = 1

  // GTAO prototype (screen-space AO): when enabled, frames render through a
  // RenderPipeline chain (scene pass with MRT normals → GTAO → denoise → multiply)
  // instead of the direct renderer.render. Built lazily by setGtao; the GTAO node
  // is public so its uniforms (radius/thickness/scale…) can be tuned live.
  private post: RenderPipeline | null = null
  gtao: ReturnType<typeof ao> | null = null
  private gtaoDenoiseRtt: ReturnType<typeof rtt> | null = null // denoise's own scaled target
  private gtaoStrength = this.lightParams.ao // AO intensity rides the lighting prefs
  private gtaoRes = 1 // AO buffer resolution scale (1 = full, 0.5 = quarter cost)

  constructor(
    private container: HTMLElement,
    opts: { antialias?: boolean; perfTimestamps?: boolean } = {},
  ) {
    // WebGPURenderer (auto WebGL2 fallback). trackTimestamp enables the GPU-timer
    // query pool for the perf HUD (resolved via resolveTimestampsAsync →
    // info.render.timestamp) — opt-out for hosts that ship no HUD (the game): the
    // query pool writes ride EVERY pass even when nothing resolves them.
    // antialias = 4× MSAA render targets (WebGPU default count).
    this.renderer = new WebGPURenderer({ trackTimestamp: opts.perfTimestamps ?? true, antialias: opts.antialias ?? false })
    container.appendChild(this.renderer.domElement)

    // Placeholder background: the sky_22 cubemap shows immediately while the 4k
    // EXR HDRI streams in (the rig swaps background + environment on load).
    const sky = loadSkybox(() => this.frame())
    this.scene.background = sky
    setLevelEnvMap(sky) // opt-in metal reflections until the HDRI replaces it

    this.camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 100)
    this.camera.position.set(2.2, 1.8, 3)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0.5, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.maxPolarAngle = Math.PI * 0.72

    const grid = new THREE.GridHelper(10, 20, 0x3a70b5, 0x4080c8)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.6
    // helpers must NOT write depth: the GTAO pass reads the depth/normal buffers,
    // and line pixels carry no meaningful normals — they'd AO to black.
    ;(grid.material as THREE.Material).depthWrite = false
    this.scene.add(grid)
    this.grid = grid

    // shared HDRI environment rig (IBL lighting only).
    this.rig = new LightingRig(this.renderer, this.scene)
    setFlatShadingEnabled(this.lightParams.flat) // global shading mode, before anything builds materials

    this.scene.add(this.root)
    this.effects = new EffectSystem(this.scene)

    // WebGPU init is ASYNC — nothing renders/compiles until the device is up. The
    // frame loop no-ops until `ready`; the HDRI load (PMREM needs the renderer) waits.
    void this.renderer.init().then(() => {
      this.ready = true
      // KTX2 transcode-target detection needs the INITIALIZED device (feature flags);
      // any ktx2 load requested earlier queued inside materials.ts and starts now.
      configureKtx2(this.renderer)
      this.resize()
      this.rig.applyParams(this.lightParams) // kicks off the HDRI load + PMREM
    })
    this.resize()
    new ResizeObserver(() => this.resize()).observe(container)

    // The Claude Preview tab runs visibility:hidden and stalls rAF — keep an
    // interval fallback so the loop (and screenshots) still work there.
    let last = -1
    const tick = () => {
      const now = performance.now()
      if (now - last >= 15) {
        last = now
        this.frame()
      }
    }
    const loop = () => {
      tick()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    setInterval(tick, 33)
  }

  // SSAA: render at scale× the display resolution and let the browser downsample —
  // brute-force antialiasing that composes with MSAA and applies LIVE (no reload).
  setRenderScale(scale: number): void {
    this.renderScale = Math.max(0.5, Math.min(2, scale))
    this.resize()
  }

  // GTAO on/off — swaps the frame path between direct render and the post chain.
  // Applies live; the chain tracks renderer size/pixelRatio on its own. NOTE the
  // canvas MSAA sample count does not reach the pass's internal target, so GTAO
  // pairs best with the SSAA antialias modes.
  setGtao(on: boolean): void {
    if (on === this.gtaoOn) return
    this.gtaoOn = on
    this.rebuildPost()
  }

  // Tilt-shift (miniature/diorama look): a horizontal band around screen center stays
  // sharp, everything toward the top/bottom edges blends into a gaussian blur.
  // On/off rebuilds the chain (off compiles no blur passes); strength is a LIVE uniform.
  setTiltShift(on: boolean): void {
    if (on === this.tiltShiftOn) return
    this.tiltShiftOn = on
    this.rebuildPost()
  }

  setTiltShiftStrength(v: number): void {
    this.tiltStrengthU.value = Math.max(0, Math.min(1, v))
  }

  // (Re)build the post chain for the current gtao/tilt-shift combination — the frame
  // renders through it whenever either effect is on, direct to canvas otherwise.
  private rebuildPost(): void {
    this.post?.dispose()
    this.post = null
    this.gtao = null
    this.gtaoDenoiseRtt = null
    if (!this.gtaoOn && !this.tiltShiftOn) return
    // samples: 0 — the pass target must NOT inherit the canvas MSAA sample count
    // (multisampling an intermediate that feeds per-pixel post math is pure bandwidth;
    // the post effects pair with the SSAA antialias modes instead).
    const scenePass = pass(this.scene, this.camera, { samples: 0 })
    let color: unknown
    if (this.gtaoOn) {
      scenePass.setMRT(mrt({ output, normal: normalView }))
      const scenePassColor = scenePass.getTextureNode('output')
      const scenePassNormal = scenePass.getTextureNode('normal')
      const scenePassDepth = scenePass.getTextureNode('depth')
      const aoPass = ao(scenePassDepth, scenePassNormal, this.camera)
      aoPass.radius.value = 0.25 // view-space meters — sized to our ~0.5–2m props
      // thin-surface halo mitigation: GTAO assumes every depth sample extends
      // `thickness` into the screen — lower = less phantom occlusion smearing
      // BEHIND objects as the camera orbits (inherent SS artifact, tunable not fixable)
      aoPass.thickness.value = 0.35
      aoPass.scale.value = this.gtaoStrength
      aoPass.resolutionScale = this.gtaoRes
      this.gtao = aoPass
      // GTAO is spatially noisy per pixel — the companion denoiser makes it presentable.
      // The 5×5-tap denoise renders into its OWN target at the AO buffer's resolution
      // (rtt + setResolutionScale) — inline it ran per FULL-RES output pixel, paying
      // 25 taps/pixel at canvas res even when the AO buffer was half/quarter size.
      const denoised = rtt(denoise(aoPass.getTextureNode(), scenePassDepth, scenePassNormal, this.camera) as never)
      denoised.setResolutionScale(this.gtaoRes)
      this.gtaoDenoiseRtt = denoised
      // AO rides the RED channel (RedFormat target) — float() takes .x, vec3 splats it
      // to gray. (as never: DenoiseNode's .d.ts lacks the fluent node typing.)
      color = scenePassColor.mul(vec4(vec3(float(denoised as never)), 1))
    } else {
      color = scenePass.getTextureNode('output')
    }
    if (this.tiltShiftOn) {
      // blur SOURCE must be a texture node (the gaussian samples it at offsets) — the
      // ao-multiplied color is a computed node, so park it in its own target first.
      const sharp = this.gtaoOn ? rtt(color as never) : (color as ReturnType<typeof rtt>)
      // half-res two-pass gaussian; the live strength uniform scales the tap offsets
      // (0 = no spread). sigma fixes the tap count at compile time.
      const blurred = gaussianBlur(sharp as never, vec2(this.tiltStrengthU, this.tiltStrengthU).mul(2) as never, 6, {
        resolutionScale: 0.5,
      })
      // the blur's internal targets default to 8-bit — force half-float or the linear
      // HDR scene clips at 1.0 inside the blur and the out-of-focus zones wash out
      // under the filmic output transform (rtt() already defaults to half-float).
      const b = blurred as unknown as { _horizontalRT: THREE.RenderTarget; _verticalRT: THREE.RenderTarget }
      b._horizontalRT.texture.type = THREE.HalfFloatType
      b._verticalRT.texture.type = THREE.HalfFloatType
      // focus band: sharp within ~12% of screen center, fully blurred past ~45%.
      // NOTE the function form — method sugar (`d.smoothstep(a,b)`) binds the node as
      // smoothstep's FIRST parameter (the low edge), which inverts the whole mask.
      const band = smoothstep(float(0.12), float(0.45), screenUV.y.sub(0.5).abs())
      color = mix(sharp as never, blurred as never, band as never)
    }
    this.post = new RenderPipeline(this.renderer)
    this.post.outputNode = color as never
  }
  private gtaoOn = false
  private tiltShiftOn = false
  private tiltStrengthU = uniform(0.5)

  gtaoEnabled(): boolean {
    return this.gtaoOn
  }

  // AO intensity — the GTAO power curve (0 = effect off, 1 = neutral, >1 = deeper).
  // A pure shader uniform: applies to the live chain instantly, nothing rebuilds.
  setGtaoStrength(v: number): void {
    this.gtaoStrength = Math.max(0, Math.min(3, v))
    if (this.gtao) this.gtao.scale.value = this.gtaoStrength
  }

  // AO buffer resolution scale — GTAO cost is per-PIXEL of its buffer, so 0.5 =
  // quarter cost (the denoiser hides most of the softening). The denoise target
  // rides the same scale. Applies live: the nodes re-size their render targets on
  // the next frame's setSize.
  setGtaoResolution(scale: number): void {
    this.gtaoRes = Math.max(0.25, Math.min(1, scale))
    if (this.gtao) this.gtao.resolutionScale = this.gtaoRes
    this.gtaoDenoiseRtt?.setResolutionScale(this.gtaoRes)
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect()
    const w = Math.max(2, r.width || this.container.clientWidth || 1280)
    const h = Math.max(2, r.height || this.container.clientHeight || 720)
    this.renderer.setSize(w, h, true)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * this.renderScale)
    this.camera.aspect = w / h
    if (!isFinite(this.camera.aspect) || this.camera.aspect <= 0) this.camera.aspect = 16 / 9
    this.camera.updateProjectionMatrix()
  }

  // Freeze the frame loop (ref-counted). Used by the shader precompile gate: the staged
  // group must be VISIBLE while renderer.compileAsync walks it (an invisible root is
  // skipped = nothing compiles), and no frame may render mid-pulse or the half-compiled
  // group flashes on screen. Returns a release fn (idempotent).
  suspend(): () => void {
    this.suspended++
    let done = false
    return () => {
      if (!done) {
        done = true
        this.suspended--
      }
    }
  }
  private suspended = 0

  frame(): void {
    if (!this.ready || this.suspended > 0) return // device initialising / compile gate holding the loop
    const dt = Math.min(this.clock.getDelta(), 0.1)
    // renderer.info.autoReset (WebGPU default) resets counts at each render() — the HUD
    // reads the last (main scene) render below, so no manual reset is needed.
    for (const fn of this.onUpdate) fn(dt)
    this.effects.update(dt)
    this.controls.update()

    if (this.shake > 0.001) {
      const s = this.shake
      this.camera.position.x += (Math.random() - 0.5) * s * 0.08
      this.camera.position.y += (Math.random() - 0.5) * s * 0.08
      this.shake *= Math.max(0, 1 - dt * 6)
    }
    const t0 = performance.now()
    if (this.post) this.post.render() // GTAO chain: scene pass → AO → denoise → multiply
    else this.renderer.render(this.scene, this.camera) // direct to canvas
    this.rig.settleShadow() // cached-shadow pulse: freeze the map again after this render
    const t1 = performance.now()
    // GPU timestamp RESOLVE is a readback round-trip — pay it at HUD cadence (~5/s,
    // and only with a HUD to show it in), not per frame.
    if (this.perfHud && t1 - this.gpuReadT > 200) {
      this.gpuReadT = t1
      this.readGpuTime()
    }
    this.updatePerfHud(t0, t1)
  }
  private gpuReadT = 0

  // WebGPU GPU timing: renderer.trackTimestamp fills info.render.timestamp (ms) once
  // resolveTimestampsAsync completes (a few frames late). Fire-and-forget, then smooth.
  private readGpuTime(): void {
    const r = this.renderer as unknown as {
      resolveTimestampsAsync?: () => Promise<void>
    }
    if (typeof r.resolveTimestampsAsync !== 'function') return
    r.resolveTimestampsAsync()
      .then(() => {
        const ms = this.renderer.info.render.timestamp
        if (typeof ms === 'number' && ms > 0) {
          this.gpuMs = this.gpuMs < 0 ? ms : this.gpuMs * 0.9 + ms * 0.1
        }
      })
      .catch(() => {
        /* timestamp-query feature unavailable — HUD falls back to CPU submit time */
      })
  }

  // smoothed CPU submit time (throttle-independent) + draw calls / tris straight
  // from renderer.info. Text refreshes ~5×/s so it's readable, not a blur.
  private updatePerfHud(t0: number, t1: number): void {
    if (!this.perfHud) return
    this.renderMs = this.renderMs * 0.9 + (t1 - t0) * 0.1
    if (this.lastFrameT >= 0) this.frameMs = this.frameMs * 0.9 + (t1 - this.lastFrameT) * 0.1
    this.lastFrameT = t1
    if (t1 - this.hudLastT < 200) return
    this.hudLastT = t1
    const r = this.renderer.info.render
    const tris = r.triangles >= 1000 ? (r.triangles / 1000).toFixed(1) + 'k' : String(r.triangles)
    const fps = this.frameMs > 0 ? Math.round(1000 / this.frameMs) : 0
    // engine fps = uncapped throughput = 1000 / real per-frame cost. GPU-bound work
    // shows up as gpuMs dominating; without the timer ext, fall back to the CPU
    // submit time (an overestimate, so it's clearly the best-effort figure).
    const gpu = this.gpuMs >= 0 ? this.gpuMs.toFixed(2) : '—'
    const cost = this.gpuMs > 0 ? Math.max(this.renderMs, this.gpuMs) : this.renderMs
    const engFps = cost > 0 ? Math.round(1000 / cost) : 0
    this.perfHud.innerHTML =
      `<b>${r.drawCalls}</b> draws · ${tris} tris\n` +
      `cpu <b>${this.renderMs.toFixed(2)}</b> · gpu <b>${gpu}</b> ms\n` +
      `<b>${fps}</b> fps · <b>${engFps}</b> eng`
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount)
  }

  // current light params (copy — mutate via setLights).
  getLights(): LightParams {
    return { ...this.lightParams }
  }

  // merge + clamp + live-apply + persist. Returns the resulting params.
  setLights(p: Partial<LightParams>): LightParams {
    this.lightParams = clampLightParams({ ...this.lightParams, ...p })
    this.rig.applyParams(this.lightParams)
    this.setGtaoStrength(this.lightParams.ao) // AO depth rides the lighting params
    this.applyFlatShading(this.lightParams.flat)
    saveLightPrefs(this.lightParams)
    return this.getLights()
  }

  // back to defaults; clears the stored prefs.
  resetLights(): LightParams {
    this.lightParams = { ...LIGHT_DEFAULTS }
    this.rig.applyParams(this.lightParams)
    this.setGtaoStrength(this.lightParams.ao)
    this.applyFlatShading(this.lightParams.flat)
    try {
      localStorage.removeItem(LIGHTS_KEY)
    } catch {
      /* non-fatal */
    }
    return this.getLights()
  }

  // Shadow-catcher "ground": the editor floats entities over a grid, so their
  // biggest shadow (onto the ground) would fall into the void. A ShadowNodeMaterial
  // disc at y=0 renders ONLY the received shadow — invisible when nothing shadows it.
  private shadowCatcher: THREE.Mesh | null = null
  private grid!: THREE.GridHelper
  private catcherHidden = false

  // Hide/show the helper floor (grid + shadow-catcher overlay). A host that brings its
  // own REAL ground (the lineup's grass plane) turns both off: the ground writes depth,
  // receives the sun shadow through the shared albedo-darkening graft, and grounds GTAO
  // properly — the overlays would double-darken on top of it.
  setHelperFloorVisible(on: boolean): void {
    this.grid.visible = on
    this.catcherHidden = !on
    if (this.shadowCatcher) this.shadowCatcher.visible = on
  }

  // Re-frame + re-render the cached sun shadow map around new scene content.
  // Call after content changes (entity rebuild, lineup batch) — the depth pass
  // runs once on the next frame, BEFORE the reveal paints (no shadow pop).
  updateShadows(bounds: THREE.Box3): void {
    this.rig.fitShadow(bounds)
    if (!this.shadowCatcher) {
      const mat = new ShadowNodeMaterial()
      mat.opacity = 0.35
      mat.transparent = true
      // no depth writes: the catcher is an overlay, not scene geometry — writing
      // depth would feed its plane into the GTAO buffers and halo the grid.
      mat.depthWrite = false
      this.shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2), mat)
      this.shadowCatcher.receiveShadow = true
      this.scene.add(this.shadowCatcher)
    }
    this.shadowCatcher.visible = !this.catcherHidden
    const c = bounds.getCenter(new THREE.Vector3())
    const r = Math.max(1, bounds.getSize(new THREE.Vector3()).length())
    this.shadowCatcher.position.set(c.x, 0.001, c.z) // a hair above the grid plane
    this.shadowCatcher.scale.setScalar(Math.max(40, r * 4)) // generous floor — shadows rarely clip it
  }

  // GLOBAL flat/faceted shading — sets the build-time default for future materials
  // and flips every LIVE catalog material in place (one cached pipeline swap each;
  // geometry untouched, so toggling back is instant).
  private applyFlatShading(on: boolean): void {
    setFlatShadingEnabled(on)
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const sm = m as THREE.MeshStandardMaterial
        if (m?.userData?.catalogMat && sm.flatShading !== on) {
          sm.flatShading = on
          sm.needsUpdate = true
        }
      }
    })
  }

  // global emissive self-illum lift — apply to each built entity's materials.
  patchEmissive(root: THREE.Object3D): void {
    this.rig.patchEmissive(root)
  }

  fit(bounds: THREE.Box3): void {
    const size = bounds.getSize(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    if (!isFinite(size.x)) return
    const radius = Math.max(size.x, size.y, size.z, 0.4)
    this.controls.target.copy(center)
    const dir = new THREE.Vector3(0.75, 0.55, 1).normalize()
    this.camera.position.copy(center).addScaledVector(dir, radius * 2.3)
    // A big box (the 44-entity lineup) backs the camera out beyond the default far plane
    // (100) and the scene far-clips to near-emptiness. Grow far to comfortably cover the
    // framed content (never shrink below the default — entity fits keep their precision).
    const far = Math.max(100, radius * 2.3 + radius * 2)
    if (this.camera.far < far) {
      this.camera.far = far
      this.camera.updateProjectionMatrix()
    }
    this.controls.update()
  }

  pick(clientX: number, clientY: number, meshes: THREE.Mesh[]): PickResult | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
    const y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera)
    // the given meshes are explicit pick targets — hit them regardless of render
    // layer (post-merge, the source primitives live on a non-rendered layer).
    this.raycaster.layers.enableAll()
    const hits = this.raycaster.intersectObjects(meshes.filter((m) => visibleInTree(m)), false)
    const hit = hits[0]
    if (!hit) return null
    const mesh = hit.object as THREE.Mesh
    const slotByIndex: string[] = mesh.userData.slotByIndex ?? []
    let matIndex = 0
    const geo = mesh.geometry
    if (geo.groups.length && hit.faceIndex !== undefined && hit.faceIndex !== null) {
      const fi = hit.faceIndex * 3
      for (const g of geo.groups) {
        const count = g.count === Infinity ? Number.MAX_SAFE_INTEGER : g.count
        if (fi >= g.start && fi < g.start + count) {
          matIndex = g.materialIndex ?? 0
          break
        }
      }
    }
    const faceNames = geo.groups.length === 6 ? ['right', 'left', 'top', 'bottom', 'front', 'back']
      : geo.groups.length === 3 ? ['side', 'top', 'bottom']
      : geo.groups.length === 2 ? ['side', 'bottom'] : ['all']
    return {
      mesh,
      nodeName: mesh.userData.nodeName,
      slot: slotByIndex[matIndex] ?? slotByIndex[0] ?? '',
      face: faceNames[matIndex] ?? 'all',
    }
  }

  // Selection highlight on the given meshes (the selected material slot): a thin white
  // SILHOUETTE stroke — an inverted-hull shell that shares the part's geometry, pushed
  // out along its normals, drawn UNDER the body (renderOrder -1, depthWrite off) so the
  // real surface paints over the interior and only the expanded rim survives. The whole
  // surface stays visible (you can pick materials over it) — no wireframe, no white fill.
  //
  // Winding-independent by design: DoubleSide (no face culling) is what makes it robust
  // to doubleWall's folded geometry — the earlier BackSide shell rendered the folded
  // back-faces and filled white. depthWrite off = the hull never occludes the body; it's
  // occluded BY later scene geometry, so the stroke is silhouette-only + occlusion-aware.
  // toneMapped off keeps the stroke a crisp constant white regardless of exposure.
  //
  // Added as a child of each source mesh, so it inherits the node's transform + animation
  // for free. Geometry is SHARED with the source — never disposed here.
  setOutline(meshes: THREE.Mesh[]): void {
    for (const o of this.outlines) {
      o.removeFromParent()
      ;((o as THREE.Mesh).material as THREE.Material).dispose()
    }
    this.outlines = []
    for (const mesh of meshes) {
      const mat = new MeshBasicNodeMaterial()
      mat.colorNode = vec3(1, 1, 1)
      mat.positionNode = positionLocal.add(normalLocal.mul(OUTLINE_THICKNESS)) // inflate along normals
      mat.side = THREE.DoubleSide
      mat.depthWrite = false
      mat.toneMapped = false
      const hull = new THREE.Mesh(mesh.geometry, mat)
      hull.renderOrder = -1 // draw before the body so the surface paints over the interior
      mesh.add(hull) // inherits node transform + animation
      this.outlines.push(hull)
    }
  }

  screenshot(): string {
    // WebGPU has no preserveDrawingBuffer; toDataURL reads the just-presented canvas
    // texture, so render immediately before grabbing (may still be blank on some
    // backends — the browser-level preview screenshot is the reliable verify path).
    this.frame()
    return this.renderer.domElement.toDataURL('image/png')
  }
}

function visibleInTree(o: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = o
  while (cur) {
    if (!cur.visible) return false
    cur = cur.parent
  }
  return true
}
