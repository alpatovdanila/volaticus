import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  type MapKind,
  type MaterialCatalogDoc,
  type ResolvedMaterialDef,
  type SurfaceDef,
} from './schema'

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

function loadTexture(path: string, srgb: boolean): THREE.Texture {
  let tex = texCache.get(path)
  if (tex) return tex
  tex = loader.load('/' + encodeURI(path))
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.NearestFilter // crisp pixel art
  tex.minFilter = THREE.NearestMipmapLinearFilter
  // Leftover gap #3: EACH of the setters above (colorSpace/wrap/filter) bumps the
  // texture's `version`, so the still-imageless base texture gets marked for upload
  // and the renderer warns "no image data found" EVERY FRAME until the async load
  // lands — a ~282-warning boot burst across all bound maps (color/normal/rough/…).
  // Reset version to 0 here; loader.load()'s own onLoad sets needsUpdate once the
  // image exists, so the single legitimate upload still happens (just after the
  // image is present).
  if (!tex.image) tex.version = 0
  texCache.set(path, tex)
  return tex
}

export function getTexture(id: string): THREE.Texture {
  return loadTexture(resolveTexturePath(id), true)
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
  // emissive loads only when tuning.emissive > 0. (height maps are no longer bound.)
  const kinds: MapKind[] = ['color', 'normal', 'roughness', 'metallic', 'ao']
  if (doc.tuning.emissive > 0) kinds.push('emissive')
  let total = 0
  let loaded = 0
  const tally = (p: string | null | undefined): void => {
    if (!p) return
    total++
    const tex = texCache.get(p)
    if (tex && tex.image) loaded++
  }
  for (const k of kinds) tally(resolveCatalogMap(doc, k))
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
// Per-slot overrides honored: tint (× material.color), flat (overrides
// tuning.flat). uvMode/uvScale/uvRot never reach the material — the factory
// bakes all three into geometry UVs (metering + rotateGroupUVs), so every slot
// binds the SHARED cache textures. opacity/cutout/doubleSided come from tuning.
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

  // height maps are still linked in the catalog JSON (maps.*.height) but are no
  // longer bound to the material — the parallax system was removed (rebuilt later).

  // emissive: only where a map exists AND the manager turned it on.
  const emissivePath = resolveCatalogMap(doc, 'emissive')
  if (emissivePath && t.emissive > 0) {
    mat.emissive.set('#ffffff')
    mat.emissiveMap = loadTexture(emissivePath, true)
    mat.emissiveIntensity = t.emissive
  }

  // per-slot flat overrides the material's default flat-shading
  mat.flatShading = def.flat ?? t.flat

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
  mat.userData.baseEmissiveIntensity = emissivePath && t.emissive > 0 ? t.emissive : 0
  return mat
}

