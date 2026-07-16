// Shared HDRI environment rig — used by the inventory studio and the material
// preview so they light identically.
//
// Model: the HDRI environment map does the AMBIENT lighting (IBL), plus ONE
// directional SUN whose direction is auto-derived from the HDRI's brightest
// texels (so shadows always agree with the visible sky) and rotates with the
// env. The sun casts a CACHED VSM shadow map: `shadow.autoUpdate` is off and the
// map re-renders only when something actually moves it — sun params, env
// rotation, HDRI swap, or new scene content via fitShadow() — never per frame.
// The HDRI is the ONLY light; the sun adds no illumination, only its cached shadow
// (grafted onto materials by patchShadow). `applyParams` drives everything live.
import * as THREE from 'three'
import {
  WebGPURenderer,
  PMREMGenerator, // WebGPU-native PMREM
  MeshStandardNodeMaterial,
  type Node,
} from 'three/webgpu'
import { uniform, materialColor, shadow, mix, float, vec3, pow } from 'three/tsl'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { setLevelEnvMap } from '../inventory/envmap'

// TSL ergonomics: the materialColor accessor surfaces as the
// UNTYPED base Node, which lacks the chainable .mul/.add proxy methods (those are
// augmented onto the TYPED Node<'float'>/Node<'vec3'>). Re-tag to the known channel
// so chaining typechecks (runtime is identical — pure float/vec3 values).
const fl = (n: unknown): Node<'float'> => n as Node<'float'>
const v3n = (n: unknown): Node<'vec3'> => n as Node<'vec3'>

// The ambient lift is `ambient × mix(albedo^0.5, white, LIFT_FLOOR)`. Two failure
// modes bracketed here: a plain `ambient × albedo` multiply dead-ends on near-black
// texels (0 × anything = 0 — cranking ambient did nothing on AI textures' pitch-black
// backs), while a big white floor reads as a desaturating WHITE OVERLAY instead of
// "more light on the texture". The gamma term (albedo^0.5) brightens darks/mids while
// PRESERVING HUE — the surface looks lit, not tinted — and a small residual floor
// still guarantees pure black lifts a little at full crank.
const LIFT_FLOOR = 0.12


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

// the stylized pack: resources/HDRI/stylized HDRI/HDRI_Files/<id>_HDRI_1k.hdr light
// probes (downsampled from the shipped 4k masters — IBL after PMREM can't tell, and
// fetch+prefilter is ~16× cheaper) + sibling <id>.webp skyboxes one level up for most
// (2k WebP re-encodes of the 4k PNG masters: ~100× smaller files, ¼ the VRAM).
// false = no sky twin (the HDR doubles as sky).
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
  { id: 'concrete_tunnel_1k', name: 'Concrete tunnel (1k)', hdr: '/HDRI/concrete_tunnel_1k.exr' },
  { id: 'qwantani_afternoon_puresky_4k', name: 'Qwantani afternoon (sky)', hdr: '/HDRI/qwantani_afternoon_puresky_4k.exr' },
  { id: 'autumn_hilly_field_4k', name: 'Autumn hilly field', hdr: '/HDRI/autumn_hilly_field_4k.exr' },
  { id: 'ticknock_02_4k', name: 'Ticknock', hdr: '/HDRI/ticknock_02_4k.exr' },
  ...STYLIZED.map(([id, png]): HdriEntry => ({
    id,
    // 'sky_linekotsi_05_b' → 'Stylized 05 b'
    name: 'Stylized ' + id.replace('sky_linekotsi_', '').replace(/_/g, ' '),
    hdr: `${STYLIZED_DIR}/HDRI_Files/${id}_HDRI_1k.hdr`,
    sky: png ? `${STYLIZED_DIR}/${id}.webp` : undefined,
  })),
]

// The subset of lighting a host reads/writes. The studio persists it to localStorage.
export interface LightParams {
  hdri: string // HDRI id (basename)
  tonemap: ToneMap // display transform (none = WYSIWYG clip, aces/agx = filmic HDR)
  rotation: number // env yaw, degrees (spins sky + IBL)
  intensity: number // IBL strength → scene.environmentIntensity
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
  // shadow softness — the penumbra width in WORLD terms (internally converted to
  // a VSM blur radius normalized by the shadow frustum size, so the same value
  // reads the same on a single prop and on the whole lineup). 0 = hard.
  shadowSoft: number
  // shadow DARKNESS — how much the sun's shadow darkens EVERYTHING (the IBL
  // ambient included), as a multiply on each material's albedo. The SUN ITSELF
  // CONTRIBUTES NO LIGHT — it exists purely as the shadow caster (direction from
  // the HDRI's brightest texels + rotation); all illumination is the HDRI's.
  // 0 = shadows off, 1 = pitch-black shadows.
  shadow: number
  // GLOBAL flat lift (a scene-wide AmbientLight): adds `ambient × albedo` to every lit
  // material — fills the pitch-black crevices the HDRI can't reach WITHOUT blowing out the
  // already-lit areas (which cranking `intensity` does). One scene knob, no per-model or
  // per-material emissive data. 0 = off (pure-HDRI look).
  ambient: number
}

export const LIGHT_DEFAULTS: LightParams = {
  hdri: 'qwantani_noon_puresky_1k', // 1k probe default — 5MB boot fetch instead of 70MB; IBL after PMREM reads the same
  tonemap: 'agx',
  rotation: 0,
  intensity: 1,
  hideBg: false,
  ao: 1,
  flat: false,
  shadowSoft: 3,
  shadow: 0.35,
  ambient: 0,
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
    hideBg: p.hideBg ?? d.hideBg,
    ao: num(p.ao as number, 0, 3, d.ao),
    flat: p.flat ?? d.flat,
    shadowSoft: num(p.shadowSoft as number, 0, 20, d.shadowSoft),
    shadow: num(p.shadow as number, 0, 1, d.shadow),
    ambient: num(p.ambient as number, 0, 1, d.ambient),
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

  private lastTonemap: ToneMap | '' = ''
  private curEnv: THREE.Texture | null = null
  private curBg: THREE.Texture | null = null
  private loadedHdri = ''
  private hiddenBg = new THREE.Color('#aeb9c2') // flat backdrop when the sky is hidden
  private params: LightParams = { ...LIGHT_DEFAULTS }

  // The SUN + its cached shadow map. Direction per HDRI comes from the probe's
  // brightest texels (sunDirs, un-rotated texture space); applyParams rotates it
  // with the env. fitShadow() frames the ortho shadow camera around the scene
  // content; the depth map re-renders ONLY on explicit requestShadowUpdate().
  private sun: THREE.DirectionalLight | null = null
  // global flat lift (params.ambient): `ambient × albedo` added to every material, driven by
  // a LIVE uniform. NOT a THREE.AmbientLight — analytic-light uniforms are baked into the
  // compiled pipelines in this stack (intensity/color changes after compile are inert), while
  // material uniforms update per frame. Node materials get a TSL emissive graft off ambientLiftU
  // (patchShadow); classic materials (imported GLBs) get emissiveMap = their own albedo map with
  // emissiveIntensity as the live knob — same math, same slider.
  private ambientLiftU = uniform(0)
  private sunDirs = new Map<string, THREE.Vector3>()
  private shadowBounds: THREE.Box3 | null = null
  // shadow DARKNESS term: the sun's shadow mask (a TSL node over the same cached
  // VSM map the lighting uses) multiplied into every material's albedo, scaled by
  // this live uniform — darkens the IBL ambient inside shadows, params.shadow.
  private shadowDarkU = uniform(LIGHT_DEFAULTS.shadow)
  private sunShadowMask: Node<'float'> | null = null

  private ownsGlobalEnv: boolean

  constructor(
    private renderer: WebGPURenderer,
    private scene: THREE.Scene,
    opts: RigOptions = {},
  ) {
    this.ownsGlobalEnv = opts.ownsGlobalEnv !== false
  }

  private ensureSun(): THREE.DirectionalLight {
    if (this.sun) return this.sun
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.VSMShadowMap // blurrable → the softness knob
    // intensity 0 FOREVER: the sun is a pure shadow-caster — the HDRI does all the
    // lighting; the shadow mask darkens albedo via the patched materials.
    const sun = new THREE.DirectionalLight('#ffffff', 0)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.autoUpdate = false // CACHED: re-renders only via requestShadowUpdate()
    sun.shadow.blurSamples = 12
    sun.shadow.bias = -0.0002
    sun.shadow.normalBias = 0.03 // low-poly facets acne guard
    this.scene.add(sun)
    this.scene.add(sun.target)
    this.sun = sun
    this.sunShadowMask = shadow(sun) as unknown as Node<'float'> // 1 = lit, 0 = shadowed
    return sun
  }

  // Mark the cached shadow map for a one-off re-render (next frame).
  // GOTCHA (three r0.185, WebGPU): the node shadow system IGNORES
  // LightShadow.needsUpdate when autoUpdate is false — the classic WebGL cached-
  // shadow idiom silently never renders the map (it stays cleared → everything
  // inside the frustum reads as shadowed, the "giant blob"). So the cache is
  // implemented by PULSING autoUpdate for exactly one rendered frame: the host
  // calls settleShadow() after each frame render to switch it back off.
  requestShadowUpdate(): void {
    if (!this.sun) return
    this.sun.shadow.autoUpdate = true
    this.sun.shadow.needsUpdate = true // harmless; future-correct if three honors it
  }

  // Call AFTER a frame rendered: returns the shadow map to cached (frozen) state.
  // BOTH flags must drop: three clears needsUpdate only when the depth texture's
  // version already matches (ShadowNode.updateBefore) — when it lags, a surviving
  // needsUpdate re-triggers the shadow render inside the NEXT render call, which
  // under a post chain is the MRT pass ("targets[1]" ShadowMaterial pipeline error,
  // poisoned frames). Settle means frozen, unconditionally.
  settleShadow(): void {
    if (!this.sun) return
    this.sun.shadow.autoUpdate = false
    this.sun.shadow.needsUpdate = false
  }

  // Frame the ortho shadow camera around the CURRENT scene content (an entity's
  // bounds, the lineup's bounds…). Call whenever content changes; also re-applied
  // internally when the sun direction moves.
  fitShadow(bounds: THREE.Box3): void {
    this.shadowBounds = bounds.clone()
    this.placeSun()
    this.requestShadowUpdate()
  }

  // position the sun + its shadow frustum from (per-HDRI direction × env rotation
  // × content bounds). No-op until both an HDRI direction and bounds exist.
  private placeSun(): void {
    const base = this.sunDirs.get(this.loadedHdri)
    if (!this.sun || !base || !this.shadowBounds) return
    const dir = base.clone().applyEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(this.params.rotation), 0))
    const center = this.shadowBounds.getCenter(new THREE.Vector3())
    const radius = Math.max(0.5, this.shadowBounds.getSize(new THREE.Vector3()).length() / 2)
    const dist = radius * 3
    this.sun.target.position.copy(center)
    this.sun.position.copy(center).addScaledVector(dir, dist)
    const cam = this.sun.shadow.camera
    // frame the CASTERS *and* the ground the shadow throws onto: at low sun
    // elevations the footprint extends well past the bounds along the shadow
    // direction, and anything outside the depth frustum simply receives nothing.
    const throwLen = radius / Math.max(0.25, dir.y) // ≈ shadow reach on the ground
    const ext = radius + Math.min(throwLen, radius * 4)
    cam.left = -ext
    cam.right = ext
    cam.top = ext
    cam.bottom = -ext
    cam.near = 0.1
    cam.far = dist + ext * 2
    cam.updateProjectionMatrix()
    this.sun.target.updateMatrixWorld()
    // softness is a WORLD-space penumbra (~5mm per slider unit): the VSM blur
    // radius is in shadow-map TEXELS, whose world size scales with the frustum —
    // normalize so the slider reads identically on a 4m prop and a 150m lineup
    // (a raw texel radius on a big map smears every shadow into one giant blob).
    this.sun.shadow.radius = Math.min(25, (this.params.shadowSoft * 5.12) / ext)
  }

  // Where is the sun in this HDRI? Scan the equirect probe for its brightest
  // texels (the sun disc) and average their directions — so the directional
  // light + shadows always agree with the visible sky. Texture-space (un-rotated);
  // ~a millisecond on a strided scan.
  private extractSunDir(tex: THREE.DataTexture): THREE.Vector3 {
    const img = tex.image as { data: Float32Array | Uint16Array; width: number; height: number }
    const { data, width, height } = img
    const half = tex.type === THREE.HalfFloatType
    const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 65536))) // ≤ ~64k samples
    const lum = (x: number, y: number): number => {
      const i = (y * width + x) * 4
      const r = half ? THREE.DataUtils.fromHalfFloat(data[i] as number) : (data[i] as number)
      const g = half ? THREE.DataUtils.fromHalfFloat(data[i + 1] as number) : (data[i + 1] as number)
      const b = half ? THREE.DataUtils.fromHalfFloat(data[i + 2] as number) : (data[i + 2] as number)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    let max = 0
    for (let y = 0; y < height; y += stride)
      for (let x = 0; x < width; x += stride) {
        const l = lum(x, y)
        if (l > max) max = l
      }
    // average the direction of everything within 10% of peak (the sun disc)
    const acc = new THREE.Vector3()
    const threshold = max * 0.9
    for (let y = 0; y < height; y += stride)
      for (let x = 0; x < width; x += stride) {
        if (lum(x, y) < threshold) continue
        // invert three's equirect mapping: u = atan2(z, x)/2π + 0.5, v = asin(y)/π + 0.5.
        // RGBE (.hdr) textures are marked flipY for GPU upload — their RAW rows are
        // inverted for a CPU scan, so mirror v (EXR data comes pre-flipped, flipY=false).
        const u = (x + 0.5) / width
        const rawV = (y + 0.5) / height
        const v = tex.flipY ? 1 - rawV : rawV
        const phi = (u - 0.5) * Math.PI * 2
        const dy = Math.sin((v - 0.5) * Math.PI)
        const h = Math.sqrt(Math.max(0, 1 - dy * dy))
        acc.add(new THREE.Vector3(h * Math.cos(phi), dy, h * Math.sin(phi)))
      }
    if (acc.lengthSq() === 0) return new THREE.Vector3(0.4, 0.8, 0.2).normalize()
    const dir = acc.normalize()
    // elevation band: skies put their brightest patch anywhere — a horizon haze band
    // (sun underground → lit from below) or a zenith cap (noon sun → shadows drop
    // straight down, no sideways read). Clamp elevation to ~[9°, 55°] so every sky
    // yields readable, art-directable shadows; azimuth stays on the rotation slider.
    const y = Math.min(0.82, Math.max(0.15, dir.y))
    let hx = dir.x
    let hz = dir.z
    const h = Math.hypot(hx, hz)
    if (h < 1e-3) {
      // zenith/nadir sun: azimuth is undefined — pick a pleasant fixed one
      hx = 0.93
      hz = 0.37
    } else {
      hx /= h
      hz /= h
    }
    const s = Math.sqrt(1 - y * y)
    return new THREE.Vector3(hx * s, y, hz * s)
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
      if (!this.sunDirs.has(id)) this.sunDirs.set(id, this.extractSunDir(tex)) // sun ↔ sky agreement
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
    // Env yaw: sky + IBL + (below) the sun all follow the same Euler. This is the free,
    // live upstream path — it works because every lit material in the engine is a NODE
    // material (catalog mats natively; imported GLBs converted at load in gltf.ts —
    // classic materials provably lose live environmentRotation in this r185 WebGPU stack).
    const rot = new THREE.Euler(0, THREE.MathUtils.degToRad(p.rotation), 0)
    this.scene.backgroundRotation.copy(rot)
    this.scene.environmentRotation.copy(rot)
    this.updateBackground() // show the HDRI sky, or a flat backdrop when hidden

    // global flat lift — live uniform for the emissive graft on every lit node material
    // (catalog mats + imported GLBs, which convert to node materials at load). No recompiles.
    this.ambientLiftU.value = p.ambient

    // SUN (shadow-caster only): softness + darkness live; direction re-derived
    // (HDRI dir × rotation). applyParams only fires on actual light edits, and
    // each is potentially "the sun moved" — one cached-shadow re-render per apply.
    const sun = this.ensureSun()
    sun.visible = p.shadow > 0 // no light to toggle — just whether the map renders
    this.shadowDarkU.value = p.shadow // live uniform — no recompiles
    this.placeSun() // also derives the scale-normalized blur radius
    this.requestShadowUpdate()
  }

  // the flat backdrop shown when the sky is hidden. Editor keeps its neutral studio grey;
  // the game overrides this to black (a lit arena reads better against void than grey).
  setHiddenBackground(color: THREE.ColorRepresentation): void {
    this.hiddenBg.set(color)
    if (this.params.hideBg) this.updateBackground()
  }

  // show the HDRI equirect as the sky, or a flat neutral backdrop when hideBg is
  // on — the IBL (scene.environment) is untouched, so lighting stays identical.
  private updateBackground(): void {
    this.scene.background = this.params.hideBg ? this.hiddenBg : (this.curBg ?? this.scene.background)
  }

  // Graft the shadow-DARKNESS term onto every entity material: albedo ×
  // mix(1, sunShadowMask, shadowDarkU) — the sun's cached shadow darkens the whole
  // surface response (IBL included), which is what makes shadows read under a bright
  // HDRI. The sun contributes NO light; all illumination is the HDRI. Idempotent per
  // material; shadowDarkU is live. (There is no emissive/self-illumination term —
  // materials never self-illuminate.)
  patchShadow(root: THREE.Object3D): void {
    this.ensureSun() // the mask node must exist before materials reference it
    const dark = mix(float(1), fl(this.sunShadowMask!), fl(this.shadowDarkU)) // 1 lit → shadowed
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const nm = m as MeshStandardNodeMaterial
        if (nm.isMeshStandardNodeMaterial) {
          if (!nm.userData.shadowPatched && nm.userData.catalogMat) {
            nm.userData.shadowPatched = true
            // materialColor already folds in .map; parallax mats carry their own colorNode
            const albedo = v3n(nm.colorNode ?? materialColor)
            nm.colorNode = albedo.mul(dark)
            // global ambient lift: + ambient × mix(albedo^0.5, white, floor) — hue-preserving
            // brighten (see LIFT_FLOOR); × dark so the fill still darkens inside sun
            // shadows. Live via ambientLiftU — no recompiles.
            nm.emissiveNode = v3n(mix(pow(albedo, vec3(0.5, 0.5, 0.5)), vec3(1, 1, 1), float(LIFT_FLOOR))).mul(dark).mul(fl(this.ambientLiftU))
            nm.needsUpdate = true
          } else if (!nm.userData.shadowPatched && nm.userData.iblFromScene && !nm.userData.exposedEmissive && !nm.emissiveMap) {
            // imported-GLB node material (converted at load): the SAME lift, minus the
            // catalog shadow-darkening colorNode graft (GLBs take the sun shadow through
            // the light itself). Skips @exposeEmissive clones (their emissive IS the glow)
            // and authored emissive maps (the graft would override that channel).
            nm.userData.shadowPatched = true
            nm.emissiveNode = v3n(mix(pow(v3n(materialColor), vec3(0.5, 0.5, 0.5)), vec3(1, 1, 1), float(LIFT_FLOOR))).mul(fl(this.ambientLiftU))
            nm.needsUpdate = true
          }
          continue
        }
        // no classic-material branch: every lit material in the engine is a node material
        // (catalog mats natively; imported GLBs converted at load in gltf.ts)
      }
    })
  }

  dispose(): void {
    this.curEnv?.dispose()
    this.curBg?.dispose()
  }
}
