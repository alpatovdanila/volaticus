// Shared HDRI environment rig — used by the inventory studio and the material
// preview so they light identically.
//
// Model: the HDRI environment map does ALL the lighting (IBL). No directional
// lights, no shadows. A global `emissive` term adds each surface's own flat color
// back as self-illumination (lifting dark/occluded IBL areas toward the WYSIWYG
// flat color). `applyParams` drives HDRI selection, env rotation/intensity, tone
// mapping, background visibility, and the emissive strength — all live.
// (Shadows were removed; they'll be rebuilt from scratch later.)
import * as THREE from 'three'
import {
  WebGPURenderer,
  PMREMGenerator, // WebGPU-native PMREM
  MeshStandardNodeMaterial,
  type Node,
} from 'three/webgpu'
import { uniform, materialEmissive, materialColor } from 'three/tsl'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { setLevelEnvMap } from '../inventory/envmap'

// TSL ergonomics: the materialColor / materialEmissive accessors surface as the
// UNTYPED base Node, which lacks the chainable .mul/.add proxy methods (those are
// augmented onto the TYPED Node<'float'>/Node<'vec3'>). Re-tag to the known channel
// so chaining typechecks (runtime is identical — pure float/vec3 values).
const fl = (n: unknown): Node<'float'> => n as Node<'float'>
const v3n = (n: unknown): Node<'vec3'> => n as Node<'vec3'>

export type ToneMap = 'none' | 'aces' | 'agx'

// selectable HDRIs (resources/HDRI/<id>.exr, served at /HDRI/<id>.exr)
export const HDRIS: { id: string; name: string }[] = [
  { id: 'qwantani_noon_puresky_1k', name: 'Qwantani noon (sky, 1k)' },
  { id: 'qwantani_afternoon_puresky_4k', name: 'Qwantani afternoon (sky)' },
  { id: 'autumn_hilly_field_4k', name: 'Autumn hilly field' },
  { id: 'ticknock_02_4k', name: 'Ticknock' },
]

// The subset of lighting a host reads/writes. The studio persists it to localStorage.
export interface LightParams {
  hdri: string // HDRI id (basename)
  tonemap: ToneMap // display transform (none = WYSIWYG clip, aces/agx = filmic HDR)
  rotation: number // env yaw, degrees (spins sky + IBL)
  intensity: number // IBL strength → scene.environmentIntensity
  emissive: number // global self-illumination 0..1: adds emissive*albedo to every
  // surface, lifting dark areas toward the WYSIWYG flat color (0 = pure HDRI lighting)
  hideBg: boolean // hide the HDRI sky (flat backdrop) but KEEP its lighting
}

export const LIGHT_DEFAULTS: LightParams = {
  hdri: 'qwantani_afternoon_puresky_4k',
  tonemap: 'agx',
  rotation: 0,
  intensity: 1,
  emissive: 0,
  hideBg: false,
}

const TONEMAPS: Record<ToneMap, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
}

const hdriUrl = (id: string) => `/HDRI/${id}.exr`

const num = (v: number, lo: number, hi: number, fb: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb

export function clampLightParams(p: Partial<LightParams>): LightParams {
  const d = LIGHT_DEFAULTS
  return {
    hdri: HDRIS.some((h) => h.id === p.hdri) ? (p.hdri as string) : d.hdri,
    tonemap: p.tonemap && p.tonemap in TONEMAPS ? p.tonemap : d.tonemap,
    rotation: num(p.rotation as number, 0, 360, d.rotation),
    intensity: num(p.intensity as number, 0, 3, d.intensity),
    emissive: num(p.emissive as number, 0, 1, d.emissive),
    hideBg: p.hideBg ?? d.hideBg,
  }
}

export interface RigOptions {
  // Whether this rig owns the GLOBAL level env pointer (envmap.ts setLevelEnvMap),
  // used for opt-in metal reflections. Only the MAIN viewport rig should — a
  // second rig (e.g. the material-preview, which has its OWN renderer / GL context)
  // must NOT, or it would hand the main scene a texture from the wrong context.
  // Default true. Its own scene.environment is still set regardless.
  ownsGlobalEnv?: boolean
}

export class LightingRig {
  // editor hook: called with the freshly loaded HDRI so the host can react to a
  // ready environment (e.g. gate effect warmup on env presence).
  onHdriLoaded: ((tex: THREE.DataTexture) => void) | null = null

  // Shared TSL uniform (live — applyParams sets .value, no recompile) driving the
  // global self-illum term that patchEmissive folds into every material.
  private emissiveU = uniform(LIGHT_DEFAULTS.emissive)
  private lastTonemap: ToneMap | '' = ''
  private curEnv: THREE.Texture | null = null
  private curBg: THREE.Texture | null = null
  private loadedHdri = ''
  private hiddenBg = new THREE.Color('#aeb9c2') // flat backdrop when the sky is hidden
  private params: LightParams = { ...LIGHT_DEFAULTS }

  private ownsGlobalEnv: boolean

  constructor(
    private renderer: WebGPURenderer,
    private scene: THREE.Scene,
    opts: RigOptions = {},
  ) {
    this.ownsGlobalEnv = opts.ownsGlobalEnv !== false
  }

  // Load the selected equirect EXR, PMREM-prefilter it for IBL, and use it as
  // BOTH the visible sky and the light source. Async; disposes the prior HDRI.
  private loadHDRI(id: string): void {
    this.loadedHdri = id
    new EXRLoader().load(hdriUrl(id), (tex) => {
      if (this.loadedHdri !== id) return tex.dispose() // superseded
      tex.mapping = THREE.EquirectangularReflectionMapping
      const pmrem = new PMREMGenerator(this.renderer)
      const envTex = pmrem.fromEquirectangular(tex).texture
      pmrem.dispose()
      this.curEnv?.dispose()
      this.curBg?.dispose()
      this.curEnv = envTex
      this.curBg = tex
      this.scene.environment = envTex
      this.updateBackground() // sky texture, or the flat backdrop if hidden
      // opt-in metal reflections use the HDRI too — but ONLY the main rig owns this
      // global pointer (a second-context preview rig must not overwrite it).
      if (this.ownsGlobalEnv) setLevelEnvMap(envTex)
      this.onHdriLoaded?.(tex) // host reacts to a ready environment
      this.applyParams(this.params)
    })
  }

  applyParams(p: LightParams): void {
    this.params = p
    if (p.hdri !== this.loadedHdri) this.loadHDRI(p.hdri)
    // tone mapping is baked into each material's shader as a define — flag every
    // material to recompile when it changes (setting the renderer alone is inert).
    if (p.tonemap !== this.lastTonemap) {
      this.renderer.toneMapping = TONEMAPS[p.tonemap]
      this.lastTonemap = p.tonemap
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material
        if (!m) return
        for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true
      })
    }
    this.scene.environmentIntensity = p.intensity
    const rot = new THREE.Euler(0, THREE.MathUtils.degToRad(p.rotation), 0)
    this.scene.environmentRotation.copy(rot)
    this.scene.backgroundRotation.copy(rot)
    this.updateBackground() // show the HDRI sky, or a flat backdrop when hidden
    this.emissiveU.value = p.emissive // live — shared uniform, every patched material picks it up
  }

  // show the HDRI equirect as the sky, or a flat neutral backdrop when hideBg is
  // on — the IBL (scene.environment) is untouched, so lighting stays identical.
  private updateBackground(): void {
    this.scene.background = this.params.hideBg ? this.hiddenBg : (this.curBg ?? this.scene.background)
  }

  // Give every entity material the global self-illum term: emissiveNode adds
  // emissive×albedo (composes onto any map-driven emissive). Shared emissiveU,
  // live via applyParams. Idempotent per material.
  patchEmissive(root: THREE.Object3D): void {
    const lift = v3n(materialColor).mul(fl(this.emissiveU)) // albedo × global emissive
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const nm = m as MeshStandardNodeMaterial
        if (!nm.isMeshStandardNodeMaterial || nm.userData.emissivePatched) continue
        nm.userData.emissivePatched = true
        nm.emissiveNode = v3n(nm.emissiveNode ?? materialEmissive).add(lift)
        nm.needsUpdate = true
      }
    })
  }

  dispose(): void {
    this.curEnv?.dispose()
    this.curBg?.dispose()
  }
}
