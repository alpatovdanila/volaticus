import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { texture, vec2, normalMap, uv, dFdx, dFdy, uniform } from 'three/tsl'
import { parallaxUvNode, isParallaxEnabled, type Uniform } from './parallax'

// loose channel-swizzle alias — TSL's published node types don't expose .r/.g/.b fluently here.
interface Ch {
  mul(x: unknown): Ch
  add(x: unknown): Ch
}
const chan = (n: unknown): { r: Ch; g: Ch; b: Ch } => n as { r: Ch; g: Ch; b: Ch }

import {
  type MapKind,
  type MaterialCatalogDoc,
  type ResolvedMaterialDef,
  type SurfaceDef,
} from './schema'

// default parallax depth for a height-map material that hasn't set tuning.height, so
// toggling POM globally shows an effect the per-material slider can then tune.
export const DEFAULT_HEIGHT = 0.05

// These PBR height maps ship in a COMPRESSED value band (e.g. 0.43–0.73), not full [0,1]. Read each
// one's actual min/max once (downsampled, same-origin canvas) and feed the parallax node's live hMin/hMax
// uniforms — otherwise the peak floats above the surface and the whole texture reads as a deep uniform
// shift ("glass with a copy behind it"). Cached by URL.
const heightRangeCache = new Map<string, { min: number; max: number }>()
function heightUrl(path: string): string {
  return '/' + encodeURI(resolveTexturePath(path))
}

// Analyze a height map's actual value band and push it into the material's live hMin/hMax uniforms. These
// PBR maps sit in a compressed range; without normalization the peak floats above the surface. Cached by
// URL; async (decodes the image) — the uniforms update the instant it lands, no rebuild.
function analyzeHeightRange(path: string, hMinU: Uniform, hMaxU: Uniform): void {
  const url = heightUrl(path)
  const cached = heightRangeCache.get(url)
  if (cached) {
    hMinU.value = cached.min
    hMaxU.value = cached.max
    return
  }
  const img = new Image()
  img.src = url
  img
    .decode()
    .then(() => {
      const S = 64
      const c = document.createElement('canvas')
      c.width = S
      c.height = S
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, S, S)
      const d = ctx.getImageData(0, 0, S, S).data
      let min = 255
      let max = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < min) min = d[i]
        if (d[i] > max) max = d[i]
      }
      const range = { min: min / 255, max: max / 255 }
      heightRangeCache.set(url, range)
      hMinU.value = range.min
      hMaxU.value = range.max
    })
    .catch(() => {
      /* best-effort; the provisional {0,1} (no normalization) stays cached */
    })
}

// Entity surface material. WebGPU/TSL: a MeshStandardNodeMaterial (honors the same
// legacy map/color/roughness props a MeshStandardMaterial does, PLUS the node hooks
// LightingRig.patchEmissive attaches). Aliased so every consumer that used to type
// these as THREE.MeshStandardMaterial has one place to track.
export type EntityMaterial = MeshStandardNodeMaterial

const texCache = new Map<string, THREE.Texture>()
const loader = new THREE.TextureLoader()

// NOTE: entity materials NEVER clone cache textures. uvScale bakes into geometry
// UVs (factory metering) and uvRot now does too (factory rotateGroupUVs), so the
// shared cache texture serves every slot regardless of direction/density — and
// merge.ts / the BatchedMesh systems (which bucket on texture uuid / resolved def)
// fold visually identical slots into one draw. The old per-slot rotated clones
// (applyUvRot + markCloneForUpdate deferral) split those buckets for nothing.

// Named surface presets (declared in inventory/settings.json "surfaces").
// LEGACY: still consulted by pre-migration `texture` slots. Catalog `material`
// slots ignore these — a catalog material carries its own roughness/metal/env.
let surfacePresets: Record<string, SurfaceDef> = {}

export function setSurfacePresets(presets: Record<string, SurfaceDef>): void {
  surfacePresets = presets
}

export function surfacePresetNames(): string[] {
  return Object.keys(surfacePresets)
}

// ---------------------------------------------------------------------------
// PBR material catalog (the new system). setMaterialCatalog is wired from each
// editor/registry boot like setSurfacePresets/setTexturePack.

let materialCatalog: Record<string, MaterialCatalogDoc> = {}

export function setMaterialCatalog(catalog: Record<string, MaterialCatalogDoc>): void {
  materialCatalog = catalog
}

// Resolve one map kind's path. Maps are single-resolution now (one path per kind).
function resolveCatalogMap(doc: MaterialCatalogDoc, kind: MapKind): string | null {
  return doc.maps[kind] ?? null
}

// The active-resolution color-map path for a catalog material id (or '' if
// unknown / color-less). Used where a legacy consumer wants a single texture
// for a slot — effect debris inheritance, editor chip thumbnails.
export function catalogColorPath(materialId: string): string {
  const doc = materialCatalog[materialId]
  if (!doc) return ''
  return resolveCatalogMap(doc, 'color') ?? ''
}

// The material's baseline (default) tint from its catalog tuning, or undefined
// if it has none. Effect/debris inheritance combines this with a per-slot tint
// override (slot tint wins; else this material default; else none).
export function catalogDefaultTint(materialId: string): string | undefined {
  return materialCatalog[materialId]?.tuning.tint ?? undefined
}

// #32: the material's DEFAULT tiling density (tuning.uvScale, repeats per meter).
// Multiplied with the per-slot uvScale by the factory's geometry UV metering —
// NEVER applied via texture.repeat on entities (UVs are baked into geometry, so
// a texture.repeat would double-apply on top of the baked metering).
export function catalogDefaultUvScale(materialId: string): number {
  return materialCatalog[materialId]?.tuning.uvScale ?? 1
}

// ---------------------------------------------------------------------------
// LEGACY resource pack (pre-catalog `texture` slots + level terrain).
// Texture ids in content stay canonical (vanilla/...); when another pack is
// active, lookups redirect per-file if the pack has it.
let activePack = 'vanilla'
let hasResourceFile: (path: string) => boolean = () => false

export function setTexturePack(pack: string, hasFile: (path: string) => boolean): void {
  activePack = pack
  hasResourceFile = hasFile
}

export function resolveTexturePath(id: string): string {
  if (activePack !== 'vanilla' && id.startsWith('vanilla/')) {
    const candidate = activePack + id.slice('vanilla'.length)
    if (hasResourceFile(candidate)) return candidate
  }
  return id
}

// Every in-flight texture decode, as a self-removing promise. whenTexturesReady() gates a
// scene reveal on "no map is still imageless" — an imageless bound map samples BLACK, which
// is exactly the black-geometry flash on entity load. Errors settle too (a missing file
// must not veil the scene forever); the texture then just stays imageless.
const pendingTextureLoads = new Set<Promise<void>>()

// Resolves when every texture load in flight RIGHT NOW (and any that start while waiting —
// the drain loops until the set is empty) has decoded or failed. Call right after building
// materials: their loadTexture calls have already queued everything the build needs.
export function whenTexturesReady(): Promise<void> {
  if (pendingTextureLoads.size === 0) return Promise.resolve()
  return Promise.allSettled([...pendingTextureLoads]).then(() => whenTexturesReady())
}

function loadTexture(path: string, srgb: boolean, linear = false): THREE.Texture {
  // `linear` gets its own cache entry so a path used elsewhere as a crisp (Nearest) map can also
  // be loaded smoothly here. Height and normal maps are CONTINUOUS data (a scalar field / packed
  // directions), so they must be bilinearly interpolated + mipmapped — Nearest reads back blocky
  // texel steps that POM and the lighting amplify. (The base colour keeps its Nearest look.)
  const key = linear ? path + '#lin' : path
  let tex = texCache.get(key)
  if (tex) return tex
  let settle!: () => void
  const pending = new Promise<void>((resolve) => (settle = resolve))
  pendingTextureLoads.add(pending)
  const done = (): void => {
    pendingTextureLoads.delete(pending)
    settle()
  }
  // loader.load's own onLoad still sets needsUpdate (upload once the image exists);
  // these callbacks only maintain the readiness set.
  tex = loader.load('/' + encodeURI(path), done, undefined, done)
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter // Nearest = crisp pixel art
  tex.minFilter = linear ? THREE.LinearMipmapLinearFilter : THREE.NearestMipmapLinearFilter
  // Leftover gap #3: EACH of the setters above (colorSpace/wrap/filter) bumps the
  // texture's `version`, so the still-imageless base texture gets marked for upload
  // and the renderer warns "no image data found" EVERY FRAME until the async load
  // lands — a ~282-warning boot burst across all bound maps (color/normal/rough/…).
  // Reset version to 0 here; loader.load()'s own onLoad sets needsUpdate once the
  // image exists, so the single legitimate upload still happens (just after the
  // image is present).
  if (!tex.image) tex.version = 0
  texCache.set(key, tex)
  return tex
}

export function getTexture(id: string): THREE.Texture {
  return loadTexture(resolveTexturePath(id), true)
}

// ---------------------------------------------------------------------------
// Decal (sprite) materials — shape "decal" rig nodes carry their image EMBEDDED as a
// base64 data URI (the entity JSON stays a full self-contained declaration). One cached
// material per distinct image: two nodes stamping the same sprite share it (and the
// merge folds them into one draw — materialKey hashes the map's uuid).
const decalCache = new Map<string, EntityMaterial>()

export function makeDecalMaterial(dataUri: string): EntityMaterial {
  let mat = decalCache.get(dataUri)
  if (mat) return mat
  mat = new MeshStandardNodeMaterial()
  // Convert the data URI to a blob: URL and load through THE texture loader — byte-for-
  // byte the catalog-map path (decode registered with the readiness gate, version-0
  // reset, same filters), so decals inherit every texture behaviour the app already has.
  // NOTE for sprite authors: a decal whose pixels are all transparent renders as NOTHING
  // (alphaTest discards every fragment) — sanity-check the sprite has opaque content.
  try {
    const [head, b64] = dataUri.split(',', 2)
    const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png'
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    let settle!: () => void
    const pending = new Promise<void>((resolve) => (settle = resolve))
    pendingTextureLoads.add(pending)
    const done = (): void => {
      URL.revokeObjectURL(url)
      pendingTextureLoads.delete(pending)
      settle()
    }
    const tex = loader.load(url, done, undefined, done)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping // decal UVs never leave 0..1
    tex.magFilter = THREE.NearestFilter // crisp pixel-art edges, same spirit as the base maps
    tex.minFilter = THREE.NearestMipmapLinearFilter
    if (!tex.image) tex.version = 0 // see loadTexture: no imageless upload attempts
    mat.map = tex
  } catch {
    // malformed data URI — flat magenta like a missing catalog material, so the gap is
    // visible rather than an invisible quad
    mat.color.set('#ff00ff')
  }
  mat.name = 'decal'
  mat.alphaTest = 0.5 // hard-edged cutout: transparent sprite pixels clip, no blend sorting
  mat.roughness = 1 // matte sticker look —
  mat.metalness = 0 // — and never reflective
  mat.envMapIntensity = 0
  // sits a hair above its parent surface without z-fighting even at glancing depths
  mat.polygonOffset = true
  mat.polygonOffsetFactor = -1
  mat.polygonOffsetUnits = -1
  mat.userData.slot = 'decal'
  mat.userData.baseEmissiveIntensity = 0
  decalCache.set(dataUri, mat)
  return mat
}

// How many of a catalog material's bound maps have finished decoding (image
// present) vs. total. A material is "still loading" while loaded < total — the
// editor uses this to show a spinner instead of a black preview mesh. texCache is
// shared + keyed by the same resolved path makeCatalogMaterial binds, so a map a
// prior material already loaded counts immediately (no false spinner).
export function materialLoadState(materialId: string): { total: number; loaded: number } {
  const doc = materialCatalog[materialId]
  if (!doc) return { total: 0, loaded: 0 }
  // Mirror makeCatalogMaterial's CONDITIONAL loads exactly, or a map that is never
  // bound keeps loaded < total forever (spinner + poll-interval never clear):
  // emissive loads only when tuning.emissive > 0; height only when the material
  // opts into parallax AND the global toggle is on (that's when the march binds it).
  const kinds: MapKind[] = ['color', 'normal', 'roughness', 'metallic', 'ao']
  if (doc.tuning.emissive > 0) kinds.push('emissive')
  if (doc.tuning.parallax && isParallaxEnabled()) kinds.push('height')
  let total = 0
  let loaded = 0
  // `linear` maps are cached under path+'#lin' (loadTexture's separate smooth-filter entry) —
  // tally the SAME key the material actually binds, or the map never counts as loaded and the
  // spinner runs forever (that was the parallax/height infinite loader).
  const tally = (p: string | null | undefined, linear = false): void => {
    if (!p) return
    total++
    const tex = texCache.get(linear ? p + '#lin' : p)
    if (tex && tex.image) loaded++
  }
  for (const k of kinds) tally(resolveCatalogMap(doc, k), k === 'height')
  tally(doc.tuning.alphaMap)
  return { total, loaded }
}

// Every entity slot references a named PBR catalog material (post-migration).
// Callers pass RESOLVED defs (schema.resolveMaterials output) — a slot that only
// inherits has its parent's values merged in before it reaches here.
export function makeSlotMaterial(slot: string, def: ResolvedMaterialDef): EntityMaterial {
  return makeCatalogMaterial(slot, def)
}

// Build a MeshStandardMaterial from a named catalog material at the active res.
// Per-slot properties honored: tint (× material.color), flat (slot-only — the
// catalog has no flat). uvMode/uvScale/uvRot never reach the material — the factory
// bakes all three into geometry UVs (metering + rotateGroupUVs), so every slot
// binds the SHARED cache textures. opacity/cutout/doubleSided come from tuning.
// GLOBAL shading mode — smooth (false) by default; the Light panel's "flat
// shading" checkbox flips it. Build-time default for new materials; the editor
// also flips LIVE materials in place (userData.catalogMat marks them). Part of
// materialKey via flatShading, and globally uniform → merge buckets stay consistent.
let flatShadingOn = false
export function setFlatShadingEnabled(on: boolean): void {
  flatShadingOn = on
}

function makeCatalogMaterial(slot: string, def: ResolvedMaterialDef): EntityMaterial {
  const mat = new MeshStandardNodeMaterial()
  mat.name = slot
  const doc = def.material !== undefined ? materialCatalog[def.material] : undefined
  if (!doc) {
    // Unknown material id / unterminated inherit chain (validation flags both).
    // Render a flat magenta so the gap is obvious rather than silently gray.
    mat.color.set('#ff00ff')
    mat.userData.slot = slot
    mat.userData.baseEmissiveIntensity = 0
    return mat
  }
  const t = doc.tuning

  // color / albedo (sRGB) — the only channel every material is guaranteed.
  const colorPath = resolveCatalogMap(doc, 'color')
  if (colorPath) mat.map = loadTexture(colorPath, true)
  // base albedo = material tint × per-slot tint (both multiply the map)
  mat.color.set('#ffffff')
  if (t.tint) mat.color.set(t.tint)
  if (def.tint) mat.color.multiply(new THREE.Color(def.tint))

  // scalar PBR params (three.js multiplies scalar × map)
  mat.roughness = t.roughness
  mat.metalness = t.metalness

  // normal (GL convention, linear), strength from tuning
  const normalPath = resolveCatalogMap(doc, 'normal')
  if (normalPath) {
    mat.normalMap = loadTexture(normalPath, false)
    mat.normalScale.set(t.normalScale, t.normalScale)
  }

  const roughPath = resolveCatalogMap(doc, 'roughness')
  if (roughPath) mat.roughnessMap = loadTexture(roughPath, false)

  const metalPath = resolveCatalogMap(doc, 'metallic')
  if (metalPath) mat.metalnessMap = loadTexture(metalPath, false)

  // AO needs a uv2 (factory sets it). aoMapIntensity from tuning.
  const aoPath = resolveCatalogMap(doc, 'ao')
  if (aoPath) {
    mat.aoMap = loadTexture(aoPath, false)
    mat.aoMapIntensity = t.aoIntensity
  }

  // Parallax occlusion mapping: opt-in at TWO levels, both BUILD-TIME — the material's own
  // tuning.parallax flag AND the global Render-panel toggle (shipping a height map alone does
  // nothing). When both are on, replace every base-UV map with a march node; otherwise the material
  // stays the plain PBR built above (classic maps, no march) — 'off' compiles NO parallax shader
  // (no gray, no cost). Depth, the value band, tint and the PBR scalars are LIVE per-material
  // uniforms and quality is a LIVE global uniform, so editing those updates with no rebuild
  // (see applyLiveTuning); toggling either parallax switch rebuilds.
  const heightPath = resolveCatalogMap(doc, 'height')
  if (heightPath && isParallaxEnabled() && t.parallax) {
    const tintU = uniform(mat.color.clone())
    const roughnessU = uniform(t.roughness)
    const metalnessU = uniform(t.metalness)
    const normalScaleU = uniform(t.normalScale)
    const aoU = uniform(t.aoIntensity)
    const heightU = uniform(t.height ?? DEFAULT_HEIGHT)
    const hMinU = uniform(0)
    const hMaxU = uniform(1)
    mat.userData.tuningU = { tintU, roughnessU, metalnessU, normalScaleU, aoU, heightU, hMinU, hMaxU }
    analyzeHeightRange(heightPath, hMinU as never, hMaxU as never) // fills hMin/hMax live (async)
    const pUv = parallaxUvNode(loadTexture(heightPath, false, true), heightU as never, hMinU as never, hMaxU as never)
    // Drive the mip from the BASE uv gradients; the march's jitter + binary refinement already kill the
    // layer-beat moire, so no grazing mip bias is needed (biasing smeared the near-cliff texels).
    const gdx = dFdx(uv())
    const gdy = dFdy(uv())
    // Every base-UV map is replaced by a pUv node below, so NULL the classic map slots: if a *Node and
    // its classic *Map both stay set, three applies BOTH — the flat base-UV copy floating over the
    // displaced one (the "semi-transparent layer in the air").
    mat.map = null
    mat.normalMap = null
    mat.roughnessMap = null
    mat.metalnessMap = null
    mat.aoMap = null
    if (colorPath) mat.colorNode = texture(loadTexture(colorPath, true), pUv).grad(gdx, gdy).mul(tintU)
    if (normalPath)
      mat.normalNode = normalMap(
        texture(loadTexture(normalPath, false, true), pUv).grad(gdx, gdy),
        vec2(normalScaleU, normalScaleU),
      )
    // Route the OTHER spatial maps through the SAME parallax UV, or roughness (→ env reflection),
    // metalness and AO sample the FLAT base UV and float as a sheet over the displaced colour+normal.
    // Channels + live scalar uniforms match three's classic map behaviour (rough=.g, metal=.b, ao=.r).
    if (roughPath)
      mat.roughnessNode = chan(texture(loadTexture(roughPath, false), pUv).grad(gdx, gdy)).g.mul(roughnessU) as never
    if (metalPath)
      mat.metalnessNode = chan(texture(loadTexture(metalPath, false), pUv).grad(gdx, gdy)).b.mul(metalnessU) as never
    if (aoPath)
      mat.aoNode = chan(texture(loadTexture(aoPath, false), pUv).grad(gdx, gdy)).r.mul(aoU).add(aoU.oneMinus()) as never
    // Classic map slots nulled → merge.ts/materialKey can't tell two parallax materials apart (all read
    // texture-less). Publish the node textures' identity + build-time depth so distinct materials don't
    // collapse into one bucket. (Live edits don't re-key: a merged bucket shares one material object, so
    // its live uniforms drive every folded slot — which is correct, they're the same catalog material.)
    mat.userData.parallaxKey =
      [colorPath, normalPath, roughPath, metalPath, aoPath, heightPath].map((p) => p ?? '_').join('|') +
      '|' + (t.height ?? DEFAULT_HEIGHT)
  }

  // emissive: only where a map exists AND tuning turned it on.
  const emissivePath = resolveCatalogMap(doc, 'emissive')
  if (emissivePath && t.emissive > 0) {
    mat.emissive.set('#ffffff')
    mat.emissiveMap = loadTexture(emissivePath, true)
    mat.emissiveIntensity = t.emissive
  }

  // shading is a GLOBAL artistic choice (Light panel "flat shading" checkbox) —
  // per-slot/per-material flat was retired; v8 bakes give every shape real smooth
  // normals, so the global flag alone decides the look
  mat.flatShading = flatShadingOn
  mat.userData.catalogMat = true // the global-flat live flip targets these

  // #27: alpha MASK (single resolution-independent path). three.js reads its green
  // channel; a linear (NoColorSpace), NearestFilter texture — loadTexture(_, false)
  // already gives exactly that. The mask combines with the tuning below: cutout →
  // hard alphaTest edges (leaves/foliage); opacity<1 → soft transparent blend.
  const hasAlphaMask = !!t.alphaMap
  if (t.alphaMap) mat.alphaMap = loadTexture(t.alphaMap, false)

  // opacity / cutout / doubleSided now live on the material (tuning). An alpha mask
  // makes the material transparent even at opacity 1 (soft mode) unless cutout is on
  // (hard-edged alphaTest) — so a mask without either flag still shows through.
  if (t.cutout) mat.alphaTest = 0.5
  if (t.opacity < 1 || (hasAlphaMask && !t.cutout)) {
    mat.transparent = true
    mat.opacity = t.opacity
    mat.depthWrite = false
  }
  if (def.doubleSided ?? t.doubleSided) mat.side = THREE.DoubleSide

  // env reflection stays opt-in via envmap.ts (never scene.environment). A
  // material reflects when it reads as metal or as a glossy surface. envmap.ts
  // only attaches the PMREM env when envMapIntensity > 0.
  //
  // #9 (roughness must visibly matter on metals): env intensity FADES with
  // roughness instead of a flat 1. A metal at roughness 1 was staying mirror-
  // bright because a scalar roughness × a dark baked roughnessMap can't reach a
  // truly matte look while the env reflection kept its full strength — so the
  // slider "did almost nothing" on metals. Fading env by (1 - roughness)^2 lets
  // driving roughness→1 kill the coherent reflection and read matte, while a
  // glossy/low-roughness surface still reflects the skybox at near-full strength.
  const reflects = t.metalness > 0 || t.roughness < 0.5
  mat.envMapIntensity = reflects ? Math.max(0, 1 - t.roughness) ** 2 : 0

  // texture direction (def.uvRot): BAKED into geometry UVs by the factory
  // (rotateGroupUVs) — every channel-0 map samples the same rotated uv, so
  // normal/rough/alpha/etc. stay aligned with the albedo without per-slot
  // texture clones (which used to split merge/batch buckets on texture uuid).

  mat.userData.slot = slot
  mat.userData.materialId = def.material // catalog id — lets a Manager edit find this instance to live-update
  mat.userData.slotDef = { tint: def.tint, doubleSided: def.doubleSided } // per-slot overrides
  mat.userData.baseEmissiveIntensity = emissivePath && t.emissive > 0 ? t.emissive : 0
  return mat
}

type MaterialTuning = MaterialCatalogDoc['tuning']

// Push a catalog material's tuning onto a LIVE material with NO rebuild. Continuous params update their
// uniforms (parallax path) or three's built-in uniforms (plain PBR) instantly. The structural flags
// (double-sided, cutout/alphaTest, transparent) can't be a uniform value — they change the shader/
// pipeline — so they flip via needsUpdate ONLY when they actually change: an in-place recompile of just
// this material, no re-merge, no geometry rebuild. Slot overrides (tint/doubleSided) layer on top.
// (flatShading is the GLOBAL Light-panel switch — deliberately untouched here.)
export function applyLiveTuning(mat: EntityMaterial, t: MaterialTuning): void {
  const sd = (mat.userData.slotDef ?? {}) as { tint?: string; doubleSided?: boolean }
  const u = mat.userData.tuningU as Record<string, { value: number | THREE.Color }> | undefined
  const tint = new THREE.Color('#ffffff')
  if (t.tint) tint.set(t.tint)
  if (sd.tint) tint.multiply(new THREE.Color(sd.tint))
  if (u) {
    ;(u.tintU.value as THREE.Color).copy(tint)
    u.roughnessU.value = t.roughness
    u.metalnessU.value = t.metalness
    u.normalScaleU.value = t.normalScale
    u.aoU.value = t.aoIntensity
    u.heightU.value = t.height ?? DEFAULT_HEIGHT
  } else {
    mat.color.copy(tint)
    mat.roughness = t.roughness
    mat.metalness = t.metalness
    mat.normalScale.set(t.normalScale, t.normalScale)
    mat.aoMapIntensity = t.aoIntensity
  }
  mat.userData.baseEmissiveIntensity = t.emissive
  mat.emissiveIntensity = t.emissive
  mat.opacity = t.opacity
  const side = (sd.doubleSided ?? t.doubleSided) ? THREE.DoubleSide : THREE.FrontSide
  if (mat.side !== side) {
    mat.side = side
    mat.needsUpdate = true
  }
  const at = t.cutout ? 0.5 : 0
  if (mat.alphaTest !== at) {
    mat.alphaTest = at
    mat.needsUpdate = true
  }
  const wantTransparent = t.opacity < 1 || (!!t.alphaMap && !t.cutout)
  if (mat.transparent !== wantTransparent) {
    mat.transparent = wantTransparent
    mat.depthWrite = !wantTransparent
    mat.needsUpdate = true
  }
}

// Fast single-parameter live update for a slider DRAG (no doc write, no full sync). Structural keys aren't
// handled here — they land on the commit via applyLiveTuning.
export function setLiveParam(mat: EntityMaterial, key: string, value: number): void {
  const u = mat.userData.tuningU as Record<string, { value: number }> | undefined
  switch (key) {
    case 'roughness':
      if (u) u.roughnessU.value = value
      else mat.roughness = value
      break
    case 'metalness':
      if (u) u.metalnessU.value = value
      else mat.metalness = value
      break
    case 'normalScale':
      if (u) u.normalScaleU.value = value
      else mat.normalScale.set(value, value)
      break
    case 'aoIntensity':
      if (u) u.aoU.value = value
      else mat.aoMapIntensity = value
      break
    case 'height':
      if (u) u.heightU.value = value
      break
    case 'emissive':
      mat.emissiveIntensity = value
      break
    case 'opacity':
      mat.opacity = value
      break
  }
}

// Live tint (catalog default × this material's slot override) for a colour-picker DRAG.
export function setTintLive(mat: EntityMaterial, catalogHex: string): void {
  const sd = (mat.userData.slotDef ?? {}) as { tint?: string }
  const c = new THREE.Color(catalogHex)
  if (sd.tint) c.multiply(new THREE.Color(sd.tint))
  const u = mat.userData.tuningU as { tintU: { value: THREE.Color } } | undefined
  if (u) u.tintU.value.copy(c)
  else mat.color.copy(c)
}

