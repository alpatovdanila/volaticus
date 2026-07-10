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
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { setLevelEnvMap } from '../inventory/envmap'

// TSL ergonomics: the materialColor / materialEmissive accessors surface as the
// UNTYPED base Node, which lacks the chainable .mul/.add proxy methods (those are
// augmented onto the TYPED Node<'float'>/Node<'vec3'>). Re-tag to the known channel
// so chaining typechecks (runtime is identical — pure float/vec3 values).
const fl = (n: unknown): Node<'float'> => n as Node<'float'>
const v3n = (n: unknown): Node<'vec3'> => n as Node<'vec3'>

export type ToneMap = 'none' | 'aces' | 'agx'

// A selectable environment: `hdr` lights the scene (PMREM → IBL); `sky`, when present,
// is a separate LDR equirect drawn as the visible background (the stylized set ships
// hand-painted PNG skies next to its .hdr light probes). No `sky` → the light probe
// itself is the sky (the photographic EXRs).
export interface HdriEntry {
  id: string
  name: string
  hdr: string // .exr (EXRLoader) or .hdr/RGBE (RGBELoader) — picked by extension
  sky?: string // LDR equirect PNG for the visible background
}

// the stylized pack: resources/HDRI/stylized HDRI/HDRI_Files/<id>_HDRI.hdr (+ sibling
// <id>.png skyboxes one level up for most). false = no PNG twin (HDR doubles as sky).
const STYLIZED: [string, boolean][] = [
  ['sky_linekotsi_01', true], ['sky_linekotsi_01_b', true], ['sky_linekotsi_01_c', false],
  ['sky_linekotsi_02', true], ['sky_linekotsi_02_b', false],
  ['sky_linekotsi_03', true], ['sky_linekotsi_04', true],
  ['sky_linekotsi_05', true], ['sky_linekotsi_05_b', true], ['sky_linekotsi_05_c', false],
  ['sky_linekotsi_06', true],
  ['sky_linekotsi_07', true], ['sky_linekotsi_07_b', true],
  ['sky_linekotsi_08', true], ['sky_linekotsi_09', true], ['sky_linekotsi_10', true],
  ['sky_linekotsi_11', true], ['sky_linekotsi_12', true], ['sky_linekotsi_13', true],
  ['sky_linekotsi_14', true], ['sky_linekotsi_14_b', true], ['sky_linekotsi_14_c', true],
  ['sky_linekotsi_15', true], ['sky_linekotsi_15_b', true],
  ['sky_linekotsi_16', true], ['sky_linekotsi_17', true], ['sky_linekotsi_18', true],
  ['sky_linekotsi_19', true], ['sky_linekotsi_20', true], ['sky_linekotsi_21', true],
  ['sky_linekotsi_22', true],
  ['sky_linekotsi_23', true], ['sky_linekotsi_23_b', true],
  ['sky_linekotsi_24', true], ['sky_linekotsi_25', true], ['sky_linekotsi_26', true],
  ['sky_linekotsi_27', true], ['sky_linekotsi_28', true],
]

const STYLIZED_DIR = encodeURI('/HDRI/stylized HDRI')

export const HDRIS: HdriEntry[] = [
  { id: 'qwantani_noon_puresky_1k', name: 'Qwantani noon (sky, 1k)', hdr: '/HDRI/qwantani_noon_puresky_1k.exr' },
  { id: 'qwantani_afternoon_puresky_4k', name: 'Qwantani afternoon (sky)', hdr: '/HDRI/qwantani_afternoon_puresky_4k.exr' },
  { id: 'autumn_hilly_field_4k', name: 'Autumn hilly field', hdr: '/HDRI/autumn_hilly_field_4k.exr' },
  { id: 'ticknock_02_4k', name: 'Ticknock', hdr: '/HDRI/ticknock_02_4k.exr' },
  ...STYLIZED.map(([id, png]): HdriEntry => ({
    id,
    // 'sky_linekotsi_05_b' → 'Stylized 05 b'
    name: 'Stylized ' + id.replace('sky_linekotsi_', '').replace(/_/g, ' '),
    hdr: `${STYLIZED_DIR}/HDRI_Files/${id}_HDRI.hdr`,
    sky: png ? `${STYLIZED_DIR}/${id}.png` : undefined,
  })),
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
  // ambient-occlusion intensity — the GTAO darkness curve (0 = off, 1 = neutral,
  // >1 = deeper contact shading). Lives WITH the lighting because AO depth is an
  // artistic call made against the current sky. The rig itself ignores it: the
  // viewport feeds it to the GTAO chain; effective only while Render → GTAO is on.
  ao: number
  // GLOBAL flat (faceted) shading — the retro low-poly look. Default OFF = smooth
  // everywhere (v8 bakes give every shape crease-welded smooth normals). Another
  // rig-ignored artistic flag: the viewport flips every catalog material in place.
  flat: boolean
}

export const LIGHT_DEFAULTS: LightParams = {
  hdri: 'qwantani_afternoon_puresky_4k',
  tonemap: 'agx',
  rotation: 0,
  intensity: 1,
  emissive: 0,
  hideBg: false,
  ao: 1,
  flat: false,
}

const TONEMAPS: Record<ToneMap, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
}

const hdriEntry = (id: string): HdriEntry => HDRIS.find((h) => h.id === id) ?? HDRIS[0]

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
    ao: num(p.ao as number, 0, 3, d.ao),
    flat: p.flat ?? d.flat,
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

  // Load the selected environment: the light probe (.exr via EXRLoader, .hdr/RGBE via
  // RGBELoader) is PMREM-prefiltered for IBL; the visible sky is the entry's PNG skybox
  // when it ships one (the stylized pack), else the probe equirect itself. Async;
  // disposes the prior environment.
  private loadHDRI(id: string): void {
    this.loadedHdri = id
    const entry = hdriEntry(id)
    const loader = entry.hdr.toLowerCase().endsWith('.hdr') ? new RGBELoader() : new EXRLoader()
    loader.load(entry.hdr, (tex) => {
      if (this.loadedHdri !== id) return tex.dispose() // superseded
      tex.mapping = THREE.EquirectangularReflectionMapping
      const pmrem = new PMREMGenerator(this.renderer)
      const envTex = pmrem.fromEquirectangular(tex).texture
      pmrem.dispose()
      const applyBg = (bg: THREE.Texture): void => {
        this.curEnv?.dispose()
        this.curBg?.dispose()
        this.curEnv = envTex
        this.curBg = bg
        this.scene.environment = envTex
        this.updateBackground() // sky texture, or the flat backdrop if hidden
        // opt-in metal reflections use the HDRI too — but ONLY the main rig owns this
        // global pointer (a second-context preview rig must not overwrite it).
        if (this.ownsGlobalEnv) setLevelEnvMap(envTex)
        this.onHdriLoaded?.(tex) // host reacts to a ready environment
        this.applyParams(this.params)
      }
      if (!entry.sky) return applyBg(tex) // the probe doubles as the sky
      // hand-painted LDR sky: sRGB equirect PNG; the probe equirect is PMREM-only, so
      // free it once the sky lands (or fall back to it if the PNG fails to load).
      new THREE.TextureLoader().load(
        entry.sky,
        (skyTex) => {
          if (this.loadedHdri !== id) {
            skyTex.dispose()
            return tex.dispose()
          }
          skyTex.mapping = THREE.EquirectangularReflectionMapping
          skyTex.colorSpace = THREE.SRGBColorSpace
          applyBg(skyTex)
          tex.dispose() // probe equirect no longer needed (PMREM captured it)
        },
        undefined,
        () => {
          if (this.loadedHdri === id) applyBg(tex)
        },
      )
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
