// Dedicated preview for the Material Manager overlay (#7). Its OWN renderer,
// scene and camera, but its LIGHTING is now the SAME as the main entity viewport:
// a LightingRig driven by the shared LightParams (HDRI + rotation + intensity +
// tonemap + emissive). So the preview is WYSIWYG-identical to what an
// entity slot renders — no bespoke key/fill lights, no separate env-intensity.
// The rig runs `ownsGlobalEnv: false` so this second GL context never overwrites
// the main scene's global env pointer.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LightingRig, type LightParams } from '../lib/lighting'

// #17: the single shape the material previews on. ball is the default.
export type PreviewShape = 'ball' | 'wall' | 'floor' | 'cube' | 'cylinder'
export const PREVIEW_SHAPES: PreviewShape[] = ['ball', 'wall', 'floor', 'cube', 'cylinder']
// (round-2: single-shape preview selector)

// Persisted preview VIEW state — the chosen shape, auto-rotate, and the
// preview-only tiling/projection must SURVIVE selecting a different material and
// reopening the overlay. Kept in localStorage so it also persists across reloads.
// (Lighting is NOT here — it comes from the shared global LightParams now.)
export type PreviewUvProject = '' | 'box' | 'planar' | 'sphere'
const PREVIEW_UV_PROJECTS: PreviewUvProject[] = ['', 'box', 'planar', 'sphere']

interface PreviewPrefs {
  shape: PreviewShape
  autoRotate: boolean
  // uvScale + uvProject are PREVIEW-ONLY tiling/projection for the shown shape —
  // deliberately NOT stored on the material (nobody needs a viewing value baked
  // into the catalog). Live here alongside shape/autoRotate.
  uvScale: number
  uvProject: PreviewUvProject
}
const PREFS_KEY = 'volaticus.matpreview'
const DEFAULT_PREFS: PreviewPrefs = {
  shape: 'ball',
  autoRotate: true,
  uvScale: 1,
  uvProject: '',
}

function loadPreviewPrefs(): PreviewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const p = JSON.parse(raw) as Partial<PreviewPrefs>
    return {
      shape: PREVIEW_SHAPES.includes(p.shape as PreviewShape) ? (p.shape as PreviewShape) : DEFAULT_PREFS.shape,
      autoRotate: typeof p.autoRotate === 'boolean' ? p.autoRotate : DEFAULT_PREFS.autoRotate,
      uvScale: typeof p.uvScale === 'number' && p.uvScale > 0 ? p.uvScale : DEFAULT_PREFS.uvScale,
      uvProject: PREVIEW_UV_PROJECTS.includes(p.uvProject as PreviewUvProject)
        ? (p.uvProject as PreviewUvProject)
        : DEFAULT_PREFS.uvProject,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function savePreviewPrefs(p: PreviewPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* private mode / quota — non-fatal, prefs just won't persist */
  }
}

export class MaterialPreview {
  renderer: WebGPURenderer // WebGPU (auto WebGL2 fallback); async-inited in the ctor
  private ready = false // renderer.init() resolved — gates the frame loop + HDRI apply
  private lastLights?: LightParams // stash if applyLights lands before the device is up
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  spin = new THREE.Group() // the auto-rotating carrier for the single preview mesh
  // view prefs restored from the last session (localStorage) instead of resetting.
  private prefs = loadPreviewPrefs()
  autoRotate = this.prefs.autoRotate
  shape: PreviewShape = this.prefs.shape // #17
  // preview-only tiling density + projection (viewing prefs, never on the material)
  uvScale = this.prefs.uvScale
  uvProject: PreviewUvProject = this.prefs.uvProject

  // shared HDRI lighting — the SAME rig type + LightParams as the entity viewport,
  // in this preview's own scene/renderer. ownsGlobalEnv:false so it can't overwrite
  // the main scene's global env pointer from this separate GL context.
  readonly rig: LightingRig

  private clock = new THREE.Clock()
  private raf = 0
  private interval: number | undefined
  private paused = true // don't render while the modal is closed (persistent preview)

  constructor(private container: HTMLElement) {
    this.renderer = new WebGPURenderer()
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.02, 100)
    this.camera.position.set(0, 0.35, 3.1)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12

    // the rig sets toneMapping / scene.environment + background itself. A pure IBL
    // material inspector (ownsGlobalEnv:false so it never overwrites the main env ptr).
    this.rig = new LightingRig(this.renderer, this.scene, { ownsGlobalEnv: false })

    this.scene.add(this.spin)

    this.resize()
    new ResizeObserver(() => this.resize()).observe(container)

    // WebGPU init is ASYNC — gate the loop until the device is up, then re-apply the
    // last lights (PMREM/HDRI load needs an inited renderer) if they arrived early.
    void this.renderer.init().then(() => {
      this.ready = true
      this.resize()
      if (this.lastLights) this.rig.applyParams(this.lastLights)
    })

    // hidden Claude-Preview tabs stall rAF — keep an interval fallback so the
    // loop and screenshots still run there.
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
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
    this.interval = window.setInterval(tick, 33)
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on
    this.persist()
  }

  setShape(shape: PreviewShape): void {
    this.shape = shape
    this.persist()
  }

  // preview-only tiling density (repeats over the preview shape) — viewing pref.
  setUvScale(v: number): void {
    this.uvScale = v
    this.persist()
  }

  // preview-only UV projection ('' = keep the shape's authored UVs) — viewing pref.
  setUvProject(v: PreviewUvProject): void {
    this.uvProject = v
    this.persist()
  }

  // Apply the shared global LightParams to this preview (HDRI + rotation + intensity
  // + tonemap + emissive). Called from the editor whenever the lights change and on
  // modal open, so the preview stays WYSIWYG-identical to the main viewport.
  applyLights(p: LightParams): void {
    this.lastLights = p
    if (this.ready) this.rig.applyParams(p) // else the ctor's init().then applies it
  }

  // Give the preview mesh the same global-emissive lift every entity slot gets, so
  // emissive reads identically. Idempotent.
  patch(obj: THREE.Object3D): void {
    this.rig.patchEmissive(obj)
  }

  // Persistent preview: the render loop idles while the modal is closed and resumes
  // on open (avoids reloading the HDRI + rendering a hidden canvas every open).
  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  private persist(): void {
    savePreviewPrefs({
      shape: this.shape,
      autoRotate: this.autoRotate,
      uvScale: this.uvScale,
      uvProject: this.uvProject,
    })
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect()
    const w = Math.max(2, r.width || this.container.clientWidth || 480)
    const h = Math.max(2, r.height || this.container.clientHeight || 360)
    this.renderer.setSize(w, h, true)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.camera.aspect = w / h
    if (!isFinite(this.camera.aspect) || this.camera.aspect <= 0) this.camera.aspect = 16 / 9
    this.camera.updateProjectionMatrix()
  }

  frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1)
    if (!this.ready || this.paused) return // idle while closed or before the device is up
    if (this.autoRotate) this.spin.rotation.y += dt * 0.6
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  screenshot(): string {
    const wasPaused = this.paused
    this.paused = false
    this.frame()
    this.paused = wasPaused
    // WebGPU: no preserveDrawingBuffer — read the just-presented canvas texture (may
    // be blank on some backends; browser-level preview screenshot is the sure path).
    return this.renderer.domElement.toDataURL('image/png')
  }

  // fit the camera to the spinning carrier's un-rotated extent
  fit(): void {
    // reset the auto-rotation so the fit box measures the un-rotated extent
    const box = new THREE.Box3().setFromObject(this.spin)
    const size = box.getSize(new THREE.Vector3())
    if (!isFinite(size.x) || size.x === 0) return
    const radius = Math.max(size.x, size.y, size.z, 0.4)
    this.controls.target.set(0, box.getCenter(new THREE.Vector3()).y, 0)
    this.camera.position.set(0, radius * 0.35, radius * 2.4)
    this.controls.update()
  }

  // Full teardown. The preview is PERSISTENT across modal open/close (pause()
  // instead) — this only runs on a hard reset, so tearing down the loop + renderer
  // is enough; the rig's HDRI textures go with the GL context.
  dispose(): void {
    cancelAnimationFrame(this.raf)
    if (this.interval !== undefined) clearInterval(this.interval)
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

// #17: build the geometry for a single preview shape, with clean even UVs and a
// uv2 (= uv) for the AO map. Each shape is centered at the origin so the
// world-fixed light and the auto-rotation read consistently.
//  ball     — smooth sphere (equirect UVs)
//  wall     — vertical plane facing +Z
//  floor    — horizontal plane in the XZ ground plane
//  cube     — segment-1 box: each face a clean 0..1 planar quad (no chamfer seams)
//  cylinder — upright cylinder with even radial UVs
export function previewShapeGeometry(shape: PreviewShape): THREE.BufferGeometry {
  let g: THREE.BufferGeometry
  switch (shape) {
    case 'ball':
      g = new THREE.SphereGeometry(0.72, 48, 32)
      break
    case 'wall':
      // vertical plane, a bit taller than wide, standing on the origin
      g = new THREE.PlaneGeometry(1.3, 1.3)
      break
    case 'floor':
      // horizontal plane laid flat (rotate the XY plane onto XZ)
      g = new THREE.PlaneGeometry(1.4, 1.4).rotateX(-Math.PI / 2)
      break
    case 'cylinder':
      g = new THREE.CylinderGeometry(0.6, 0.6, 1.2, 40, 1, false)
      break
    case 'cube':
    default:
      // BoxGeometry lays out each of its 6 faces as a clean 0..1 quad — exactly
      // the requested clean planar-per-face box (no RoundedBox chamfer crowding).
      g = new THREE.BoxGeometry(1.1, 1.1, 1.1)
      break
  }
  const uv = g.getAttribute('uv')
  if (uv && !g.getAttribute('uv2')) g.setAttribute('uv2', uv)
  return g
}
