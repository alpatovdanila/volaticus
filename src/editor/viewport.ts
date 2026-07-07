import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { setLevelEnvMap } from '../inventory/envmap'
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

  constructor(private container: HTMLElement) {
    // WebGPURenderer (auto WebGL2 fallback). trackTimestamp enables the GPU-timer
    // query pool for the perf HUD (resolved via resolveTimestampsAsync →
    // info.render.timestamp). No antialiasing — that system was removed.
    this.renderer = new WebGPURenderer({ trackTimestamp: true })
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
    this.scene.add(grid)

    // shared HDRI environment rig (IBL lighting only).
    this.rig = new LightingRig(this.renderer, this.scene)

    this.scene.add(this.root)
    this.effects = new EffectSystem(this.scene)

    // WebGPU init is ASYNC — nothing renders/compiles until the device is up. The
    // frame loop no-ops until `ready`; the HDRI load (PMREM needs the renderer) waits.
    void this.renderer.init().then(() => {
      this.ready = true
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

  private resize(): void {
    const r = this.container.getBoundingClientRect()
    const w = Math.max(2, r.width || this.container.clientWidth || 1280)
    const h = Math.max(2, r.height || this.container.clientHeight || 720)
    this.renderer.setSize(w, h, true)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.camera.aspect = w / h
    if (!isFinite(this.camera.aspect) || this.camera.aspect <= 0) this.camera.aspect = 16 / 9
    this.camera.updateProjectionMatrix()
  }

  frame(): void {
    if (!this.ready) return // WebGPU device still initialising — nothing to render yet
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
    this.renderer.render(this.scene, this.camera) // direct to canvas
    const t1 = performance.now()
    this.readGpuTime()
    this.updatePerfHud(t0, t1)
  }

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
    saveLightPrefs(this.lightParams)
    return this.getLights()
  }

  // back to defaults; clears the stored prefs.
  resetLights(): LightParams {
    this.lightParams = { ...LIGHT_DEFAULTS }
    this.rig.applyParams(this.lightParams)
    try {
      localStorage.removeItem(LIGHTS_KEY)
    } catch {
      /* non-fatal */
    }
    return this.getLights()
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

  // Thin static outline on the given meshes (the selected material slot).
  // Closed shapes get an inflated back-face shell (silhouette contour);
  // flat shapes (plane/cross) get edge lines.
  setOutline(meshes: THREE.Mesh[]): void {
    for (const o of this.outlines) {
      o.removeFromParent()
      if (o.userData.ownGeometry) (o as THREE.Mesh).geometry.dispose()
      const mat = (o as THREE.Mesh).material as THREE.Material
      mat.dispose()
    }
    this.outlines = []
    const GROW = 0.012 // outline thickness in meters, per side
    for (const mesh of meshes) {
      let outline: THREE.Object3D
      if (mesh.geometry.type === 'PlaneGeometry') {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: '#ffffff' }),
        )
        edges.scale.setScalar(1.02)
        edges.userData.ownGeometry = true
        outline = edges
      } else {
        const shell = new THREE.Mesh(
          mesh.geometry, // shared with the source mesh — never disposed here
          new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.BackSide }),
        )
        mesh.geometry.computeBoundingBox()
        const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3())
        shell.scale.set(
          (size.x + GROW * 2) / Math.max(size.x, 1e-4),
          (size.y + GROW * 2) / Math.max(size.y, 1e-4),
          (size.z + GROW * 2) / Math.max(size.z, 1e-4),
        )
        shell.userData.ownGeometry = false
        outline = shell
      }
      mesh.add(outline) // inherits node transforms and animation
      this.outlines.push(outline)
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
