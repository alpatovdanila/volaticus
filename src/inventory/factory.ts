// Builds a live THREE object tree from an entity doc. Used identically by the
// editor preview and (later) the game — what the editor shows is what ships.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Brush, Evaluator, SUBTRACTION, ADDITION, INTERSECTION } from 'three-bvh-csg'
import { randRange } from '../lib/rng'
import { catalogDefaultUvScale, makeDecalMaterial, makeSlotMaterial, type EntityMaterial } from './materials'
import { getMeshGeometry } from './meshes'
import type { GltfModel } from './gltf'
import {
  craftAmount,
  generateArrowPlank,
  generateDisk,
  generatePlank,
  generatePost,
  generateRing,
  generateStar,
  generateTree,
  generateTube,
  hash3,
  subdivideTriangleSoup,
  type GeneratedGeometry,
} from './procgeom'
import {
  resolveMaterials,
  walkRig,
  type BooleanMod,
  type EntityDoc,
  type FaceKey,
  type NodeDef,
  type ResolvedMaterialDef,
} from './schema'

// generated shapes: always jittered (craft defaults to 0.5), authored UVs
const GENERATED_SHAPES = new Set<NodeDef['shape']>(['plank', 'post', 'ring', 'arrow', 'star'])

function toBufferGeometry(g: GeneratedGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2))
  geo.setIndex(g.indices)
  for (const grp of g.groups ?? []) geo.addGroup(grp.start, grp.count, grp.materialIndex)
  computeCreasedNormals(geo)
  return geo
}

// Crease-angle vertex normals — the INDUSTRY-STANDARD normal computation (the
// algorithm behind three's BufferGeometryUtils.toCreasedNormals, Blender's
// smooth-by-angle, assimp's GenSmoothNormals, Unity's import "smoothing angle"):
// corners are welded by QUANTIZED POSITION (not by index), face normals are
// accumulated per welded cluster, and a corner only receives the faces within
// the crease angle of its own patch — so intentional hard edges (box corners,
// cap rims, ~90°) stay hard while everything smoother welds.
//
// Why not plain computeVertexNormals: it averages per INDEX, but closed surfaces
// carry duplicated vertex columns at their UV wrap (cylinder/tube/sphere u=0|u=N
// meridian). Each copy then averages only its own side's facets and the meridian
// renders as a vertical lighting line that no uvMode can hide.
//
// Adaptations vs toCreasedNormals (which un-indexes — 3× the sidecar size):
// the index is KEPT, so the crease test runs between coincident indices' patch
// normals rather than per face-corner — equivalent here because our sources
// (three primitives, procgeom) already duplicate vertices at every hard edge.
// Accumulation stays area-weighted (raw cross products, computeVertexNormals'
// convention) so smooth interiors shade exactly as before. Non-indexed soup
// (subdivided crafted / generated shapes) gets the per-corner variant below, so
// SMOOTH normals exist everywhere — whether a part renders faceted or smooth is
// then purely the slot's `flat` flag, and the toggle works on every geometry.
const CREASE_DOT = Math.cos(THREE.MathUtils.degToRad(60)) // 60° = three/Unity default
function computeCreasedNormals(geo: THREE.BufferGeometry): void {
  if (!geo.index) {
    computeCreasedNormalsSoup(geo)
    return
  }
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const idx = geo.index
  const n = pos.count
  // area-weighted accumulation per index (identical to computeVertexNormals)
  const acc = new Float32Array(n * 3)
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t),
      b = idx.getX(t + 1),
      c = idx.getX(t + 2)
    const ax = pos.getX(a),
      ay = pos.getY(a),
      az = pos.getZ(a)
    const e1x = pos.getX(b) - ax,
      e1y = pos.getY(b) - ay,
      e1z = pos.getZ(b) - az
    const e2x = pos.getX(c) - ax,
      e2y = pos.getY(c) - ay,
      e2z = pos.getZ(c) - az
    const fx = e1y * e2z - e1z * e2y
    const fy = e1z * e2x - e1x * e2z
    const fz = e1x * e2y - e1y * e2x
    for (const i of [a, b, c]) {
      acc[i * 3] += fx
      acc[i * 3 + 1] += fy
      acc[i * 3 + 2] += fz
    }
  }
  // weld corners by quantized position (||0 folds -0 into 0)
  const clusters = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4) || 0},${Math.round(pos.getY(i) * 1e4) || 0},${Math.round(pos.getZ(i) * 1e4) || 0}`
    const list = clusters.get(key)
    if (list) list.push(i)
    else clusters.set(key, [i])
  }
  const out = new Float32Array(n * 3)
  out.set(acc)
  for (const list of clusters.values()) {
    if (list.length < 2) continue
    // unit patch normals for the crease test; sums stay area-weighted
    const unit = list.map((i) => {
      const x = acc[i * 3],
        y = acc[i * 3 + 1],
        z = acc[i * 3 + 2]
      const inv = 1 / (Math.hypot(x, y, z) || 1)
      return [x * inv, y * inv, z * inv]
    })
    for (let a = 0; a < list.length; a++) {
      let sx = 0,
        sy = 0,
        sz = 0
      for (let b = 0; b < list.length; b++) {
        if (unit[a][0] * unit[b][0] + unit[a][1] * unit[b][1] + unit[a][2] * unit[b][2] > CREASE_DOT) {
          const j = list[b]
          sx += acc[j * 3]
          sy += acc[j * 3 + 1]
          sz += acc[j * 3 + 2]
        }
      }
      const i = list[a]
      out[i * 3] = sx
      out[i * 3 + 1] = sy
      out[i * 3 + 2] = sz
    }
  }
  for (let i = 0; i < n; i++) {
    const x = out[i * 3],
      y = out[i * 3 + 1],
      z = out[i * 3 + 2]
    const inv = 1 / (Math.hypot(x, y, z) || 1)
    out[i * 3] = x * inv
    out[i * 3 + 1] = y * inv
    out[i * 3 + 2] = z * inv
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3))
}

// Non-indexed triangle soup (subdivided crafted shapes, generated planks/posts/
// rings): every corner is its own vertex, so this is the CLASSIC per-corner
// creased-normals pass (exactly three's toCreasedNormals): weld corners by
// quantized position, then each corner sums the area-weighted normals of the
// cluster's faces that lie within the crease angle of its OWN face. Coplanar
// facets of one surface weld smooth; bevels/corners past 60° stay hard.
function computeCreasedNormalsSoup(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count
  const triCount = (n / 3) | 0
  // area-weighted face normals + unit copies for the crease test
  const face = new Float32Array(triCount * 3)
  const faceUnit = new Float32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    const a = t * 3,
      b = a + 1,
      c = a + 2
    const ax = pos.getX(a),
      ay = pos.getY(a),
      az = pos.getZ(a)
    const e1x = pos.getX(b) - ax,
      e1y = pos.getY(b) - ay,
      e1z = pos.getZ(b) - az
    const e2x = pos.getX(c) - ax,
      e2y = pos.getY(c) - ay,
      e2z = pos.getZ(c) - az
    const fx = e1y * e2z - e1z * e2y
    const fy = e1z * e2x - e1x * e2z
    const fz = e1x * e2y - e1y * e2x
    face[t * 3] = fx
    face[t * 3 + 1] = fy
    face[t * 3 + 2] = fz
    const inv = 1 / (Math.hypot(fx, fy, fz) || 1)
    faceUnit[t * 3] = fx * inv
    faceUnit[t * 3 + 1] = fy * inv
    faceUnit[t * 3 + 2] = fz * inv
  }
  // weld corners by quantized position (||0 folds -0 into 0)
  const clusters = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4) || 0},${Math.round(pos.getY(i) * 1e4) || 0},${Math.round(pos.getZ(i) * 1e4) || 0}`
    const list = clusters.get(key)
    if (list) list.push(i)
    else clusters.set(key, [i])
  }
  const out = new Float32Array(n * 3)
  for (const list of clusters.values()) {
    for (const i of list) {
      const f = (i / 3) | 0
      const nx = faceUnit[f * 3],
        ny = faceUnit[f * 3 + 1],
        nz = faceUnit[f * 3 + 2]
      let sx = 0,
        sy = 0,
        sz = 0
      for (const j of list) {
        const g = ((j / 3) | 0) * 3
        if (nx * faceUnit[g] + ny * faceUnit[g + 1] + nz * faceUnit[g + 2] > CREASE_DOT) {
          sx += face[g]
          sy += face[g + 1]
          sz += face[g + 2]
        }
      }
      const inv = 1 / (Math.hypot(sx, sy, sz) || 1)
      out[i * 3] = sx * inv
      out[i * 3 + 1] = sy * inv
      out[i * 3 + 2] = sz * inv
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3))
}

// generic "proceduralizator": seeded vertex jitter on any built-in shape.
// Positions are hashed in ENTITY space (the node's BASE-pose transform chain),
// with the node's stored craftSeed — so coincident vertices of DIFFERENT nodes
// (e.g. two frame rails meeting at a corner) receive the same offset and the seam
// stays sealed IFF the two nodes share a seed. computeSeamGroups guarantees that:
// nodes that touch are one seam-group and are always seeded together.
function applyCraftJitter(geo: THREE.BufferGeometry, craft: number, matrix: THREE.Matrix4, seed: number): void {
  geo.computeBoundingBox()
  const size = geo.boundingBox!.getSize(new THREE.Vector3())
  const bx = new THREE.Vector3()
  const by = new THREE.Vector3()
  const bz = new THREE.Vector3()
  matrix.extractBasis(bx, by, bz)
  const entityDims = [size.x * bx.length(), size.y * by.length(), size.z * bz.length()]
  // flat shapes (planes) have a ~zero dimension — ignore it or nothing jitters
  const dims = entityDims.filter((d) => d > 0.02)
  const amount = craftAmount(craft, dims.length ? Math.min(...dims) : Math.max(...entityDims))
  if (amount <= 0) return
  const inv = matrix.clone().invert()
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix)
    const [dx, dy, dz] = hash3(v.x, v.y, v.z, seed)
    v.x += dx * amount
    v.y += dy * amount
    v.z += dz * amount
    v.applyMatrix4(inv)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  pos.needsUpdate = true
  computeCreasedNormals(geo)
}

// Midpoint-subdivide any geometry (group-aware, output non-indexed). Runs
// before craft jitter so abstract shapes get enough vertices to deform.
function subdivideGeometry(geo: THREE.BufferGeometry, levels: number): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo
  const pos = Array.from((src.getAttribute('position') as THREE.BufferAttribute).array as Float32Array)
  const uv = Array.from((src.getAttribute('uv') as THREE.BufferAttribute).array as Float32Array)
  const vertCount = pos.length / 3
  const groups = src.groups.length
    ? src.groups
    : geo.groups.length
      ? geo.groups
      : [{ start: 0, count: vertCount, materialIndex: 0 }]

  const out = new THREE.BufferGeometry()
  const outPos: number[] = []
  const outUv: number[] = []
  for (const g of groups) {
    const count = g.count === Infinity ? vertCount - g.start : g.count
    const sub = subdivideTriangleSoup(
      pos.slice(g.start * 3, (g.start + count) * 3),
      uv.slice(g.start * 2, (g.start + count) * 2),
      levels,
    )
    out.addGroup(outPos.length / 3, sub.positions.length / 3, g.materialIndex ?? 0)
    // no spread-push: subdivided parts run to 100k+ elements, past the arg-count limit
    for (const p of sub.positions) outPos.push(p)
    for (const u of sub.uvs) outUv.push(u)
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
  computeCreasedNormalsSoup(out) // smooth-capable normals even when no craft pass follows
  if (src !== geo) src.dispose()
  return out
}

export interface BuiltNode {
  // animation target, origin at the node's pivot point. A Group for rigid entities,
  // a Bone for skinned ones (doc.skinned) — identical Object3D interface either way.
  outer: THREE.Group | THREE.Bone
  inner: THREE.Group // geometry + children live here (offset by -pivot)
  base: { pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3 }
  defaultVisible: boolean
}

export interface BuiltEntity {
  group: THREE.Group
  nodes: Map<string, BuiltNode>
  meshes: THREE.Mesh[]
  slotMaterials: Map<string, EntityMaterial>
  bounds: THREE.Box3
  seed: number
  // legacy per-instance tint multiplier — always 1 now (tint jitter moved to the
  // level editor). Kept so batching code that divides it back out still compiles.
  tintK: number
  // IMPORTED GLB entities only (buildGlbEntity): the model's own AnimationMixer + clips
  // drive its native skeleton. EntityPreview plays these via the mixer instead of
  // AnimPlayer. Undefined for procedural entities (the AnimPlayer path is unchanged).
  mixer?: THREE.AnimationMixer
  clips?: THREE.AnimationClip[]
  // GLB meshes tagged "<part>@exposeEmissive": their CLONED materials (so only that part
  // glows), keyed by exposed part name. The editor's emissive control edits these live.
  emissiveParts?: Map<string, THREE.MeshStandardMaterial>
}

// A GLB mesh named "<part>@exposeEmissive[.NNN]" opts into a per-part emissive glow. Returns
// the exposed part name ("crystal") or null. The tag lives in the mesh name so the model
// author declares intent in Blender; the editor surfaces a colour+intensity control for it.
export function exposedEmissiveName(meshName: string): string | null {
  const m = /^(.+?)@exposeEmissive/.exec(meshName)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Baked geometry: the studio composes this (bakeEntityGeometry) and stores it in
// <id>.geom.{i}.json; the runtime loads it (buildEntity) and never generates. Per
// NODE, so anims/states/shatter still address nodes by name. UVs are stored in
// METERS (base), then metered/projected + uvRot'd live at load so material edits
// reflect without a re-bake. Each variant is composed from a resolved LAYOUT
// (<id>.variants.json: the present parts, each with final pos+rot) against parts
// baked ONCE in base pose — a node absent from the layout is absent from `nodes`;
// each present node carries its final pos + rot.
export interface BakedNodeGeom {
  positions: number[]
  normals: number[]
  uv: number[] // meters, pre-metering
  index: number[] // empty = non-indexed
  groups: [number, number, number][] // [start, count, materialIndex]
  // (bake v5–v6 stored per-vertex AO here as `ao: number[]` — retired; sidecars
  // baked in that window may still carry the inert key, the loader ignores it.)
}
// A node in the baked SCENE TREE. It mirrors the rig node's render-relevant fields
// (shape/material/pivot/scale/hidden) + the resolved transform + geometry + nested
// children, so the geom file is a self-contained tree (glTF-style): the
// runtime builds from it ALONE and only looks up material definitions + anims (by
// the slot/node names carried here) in the main file. Generation inputs (craft/sub/
// size/segments/craftSeed/chance/rotJitter) are NOT copied — they're bake-time only.
export interface BakedNode {
  pos: [number, number, number] // final local position (always present)
  rot: [number, number, number] // final local rotation, rotJitter rolled in (always present)
  scale?: number | [number, number, number]
  pivot?: [number, number, number]
  hidden?: boolean
  shape?: NodeDef['shape'] // drives per-face material mapping + cross/mesh/decal handling at load
  material?: NodeDef['material'] // slot name(s) — resolved against the main file's `materials` (which also carry uvProject)
  image?: string // shape "decal" only: the embedded sprite (base64 data URI), copied so the sidecar stays self-contained
  geom?: BakedNodeGeom // absent on pure-group (shapeless) nodes
  children?: Record<string, BakedNode> // nested subtree (the rig hierarchy, baked in)
}
export interface BakedVariant {
  nodes: Record<string, BakedNode> // ROOT nodes; the tree nests via BakedNode.children
  // studio-stamped fingerprint of the generation INPUTS (rig + variants config) this file
  // was baked from — loadBaked re-bakes when it doesn't match the current doc, so a
  // hand-edited entity JSON self-heals its sidecars. The runtime ignores it.
  rigHash?: string
}
export type BakedGeometry = BakedVariant[] // one entry per variant

// BoxGeometry group order: +x -x +y -y +z -z
const BOX_GROUP_FACES: FaceKey[] = ['right', 'left', 'top', 'bottom', 'front', 'back']
// CylinderGeometry / ConeGeometry group order
const CYL_GROUP_FACES: FaceKey[] = ['side', 'top', 'bottom']
const CONE_GROUP_FACES: FaceKey[] = ['side', 'bottom']

function resolveFaceSlot(mat: NodeDef['material'], face: FaceKey): string {
  if (typeof mat === 'string') return mat
  const m = mat ?? {}
  if (face === 'top' || face === 'bottom') return m[face] ?? m.all ?? m.side ?? firstSlot(m)
  if (face === 'side') return m.side ?? m.all ?? firstSlot(m)
  // box side faces fall back to "side" then "all"
  return m[face] ?? m.side ?? m.all ?? firstSlot(m)
}

function firstSlot(m: Record<string, string | undefined>): string {
  for (const v of Object.values(m)) if (v) return v
  return ''
}

// #32: the EFFECTIVE tiling density of a slot = per-slot uvScale × the catalog
// material's default uvScale (tuning.uvScale). Both bake into geometry UVs by
// the metering below — texture.repeat is never used for entity tiling, so a
// material-default change re-meters exactly like a slot change does.
function effectiveUvScale(def: ResolvedMaterialDef): number {
  return (def.uvScale ?? 1) * (def.material ? catalogDefaultUvScale(def.material) : 1)
}

// The unique vertex indices one geometry group touches.
function groupVerts(geo: THREE.BufferGeometry, start: number, count: number): Set<number> {
  const index = geo.getIndex()
  const verts = new Set<number>()
  for (let i = start; i < start + count; i++) verts.add(index ? index.getX(i) : i)
  return verts
}

// Split a slot's uvMode into its per-axis modes: a single value applies to both axes,
// a space-separated pair is "U V" (texture axes, pre-uvRot). See the schema comment.
type AxisMode = 'tile' | 'fit' | 'stretch'
function uvModesOf(uvMode: string | undefined): [AxisMode, AxisMode] {
  const [a, b] = (uvMode ?? 'tile').split(' ')
  return [a as AxisMode, (b ?? a) as AxisMode]
}

// Meter one group's uv coords — the UVs must already be in METERS (1 uv unit =
// 1 world meter). FULLY independent per axis (modeU × modeV, any combination):
//   tile   : uvScale repeats per meter (raw meters × scale)
//   fit    : whole repeats over the group's uv extent — patterns never cut mid-motif;
//            on a wrap axis (a barrel side's circumference) the seam tiles seamlessly
//   stretch: exactly once over the extent
// Shared by the tiling path AND the uv-projection path so every mode composes
// with every projection (#32: projection used to be suspected of dropping this).
function meterGroupUVs(
  uv: THREE.BufferAttribute,
  verts: Set<number>,
  modeU: AxisMode,
  modeV: AxisMode,
  scale: number,
): void {
  if (modeU === 'tile' && modeV === 'tile') {
    if (scale !== 1) for (const vi of verts) uv.setXY(vi, uv.getX(vi) * scale, uv.getY(vi) * scale)
    return
  }
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity
  for (const vi of verts) {
    const uu = uv.getX(vi),
      vv = uv.getY(vi)
    if (uu < minU) minU = uu
    if (uu > maxU) maxU = uu
    if (vv < minV) minV = vv
    if (vv > maxV) maxV = vv
  }
  const eu = Math.max(maxU - minU, 1e-6)
  const ev = Math.max(maxV - minV, 1e-6)
  // repeats over the extent for the normalized modes (fit = whole count, stretch = 1)
  const ru = modeU === 'fit' ? Math.max(1, Math.round(eu * scale)) : 1
  const rv = modeV === 'fit' ? Math.max(1, Math.round(ev * scale)) : 1
  for (const vi of verts) {
    const u = modeU === 'tile' ? uv.getX(vi) * scale : ((uv.getX(vi) - minU) / eu) * ru
    const v = modeV === 'tile' ? uv.getY(vi) * scale : ((uv.getY(vi) - minV) / ev) * rv
    uv.setXY(vi, u, v)
  }
}

// Bake the slot's uvRot into the geometry UVs — replaces the per-slot texture
// CLONES materials.ts used to make (texture.rotation), which split merge.ts /
// BatchedMesh buckets on texture uuid for visually identical slots.
//
// Convention (pixel-equivalent to the old texture-space path): three applies
// texture.rotation=θ in the vertex shader as uv' = Matrix3.setUvTransform(...)·uv,
// which for repeat=1/offset=0/center=(0.5,0.5) is
//   uv' = center + R(−θ)·(uv − center)
// i.e. the SAMPLING coordinates rotate by −θ (clockwise) around (0.5, 0.5) of the
// UV plane, making the texture READ as rotated +θ CCW on the surface. We bake that
// exact affine map into the uv attribute AFTER metering (the shader applied it to
// the final metered UVs too). Affine per-vertex transforms commute with barycentric
// interpolation, so rasterized UVs — and every channel-0 map (color/normal/rough/
// metal/alpha/emissive/ao) — land on identical texels.
function rotateGroupUVs(uv: THREE.BufferAttribute, verts: Set<number>, uvRot: number | undefined): void {
  if (!uvRot) return
  const rad = THREE.MathUtils.degToRad(uvRot)
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  for (const vi of verts) {
    const du = uv.getX(vi) - 0.5
    const dv = uv.getY(vi) - 0.5
    uv.setXY(vi, c * du + s * dv + 0.5, c * dv - s * du + 0.5)
  }
}

function indexCount(geo: THREE.BufferGeometry): number {
  return geo.getIndex() ? geo.getIndex()!.count : geo.getAttribute('position').count
}

interface FaceRepeat {
  face: FaceKey
  su: number
  sv: number
}

// segments to make a box/plane's cells roughly square (fixing the ASPECT so
// subdivision/jitter act uniformly) — only used when the node deforms
function aspectSegs(dim: number, minDim: number): number {
  return Math.max(1, Math.min(6, Math.round(dim / Math.max(minDim, 0.01))))
}

// effCraft/effSub = the node's EFFECTIVE generation options after rig-tree inheritance
// (own value ?? nearest ancestor's — resolved by the caller's walk), not node.craft/node.sub.
// ---------------------------------------------------------------------------
// Half/quarter primitives + arch (chest lids, lamp rings, hooks, domes). Composed
// from three primitives + manual caps, merged to ONE group with UVs pre-baked to
// METERS (faces su/sv = 1, like the generated lumber) — mixed part parameterizations
// can't share a single su/sv factor pair. `thickness` turns the sphere/cylinder
// halves into hollow shells (inner surface + rim faces); absent = solid (flat caps).

// reverse winding + negate normals — inner surfaces of hollow shells
function flipInsideOut(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = geo.getIndex()!
  const a = idx.array as Uint32Array
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1]
    a[i + 1] = a[i + 2]
    a[i + 2] = t
  }
  idx.needsUpdate = true
  const n = geo.getAttribute('normal') as THREE.BufferAttribute
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i))
  return geo
}

function scaleUv(geo: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv)
  return geo
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  return merged
}

// dome (flat side down at y=0, apex up). thickness → hollow bowl shell with a rim ring.
function buildHalfSphere(r: number, seg: number, segY: number, t?: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    scaleUv(new THREE.SphereGeometry(r, seg, segY, 0, Math.PI * 2, 0, Math.PI / 2), 2 * Math.PI * r, (Math.PI / 2) * r),
  ]
  if (t !== undefined) {
    parts.push(
      flipInsideOut(
        scaleUv(
          new THREE.SphereGeometry(Math.max(0.001, r - t), seg, segY, 0, Math.PI * 2, 0, Math.PI / 2),
          2 * Math.PI * r,
          (Math.PI / 2) * r,
        ),
      ),
    )
    parts.push(scaleUv(new THREE.RingGeometry(Math.max(0.001, r - t), r, seg).rotateX(Math.PI / 2), 2 * r, 2 * r))
  } else {
    parts.push(scaleUv(new THREE.CircleGeometry(r, seg).rotateX(Math.PI / 2), 2 * r, 2 * r))
  }
  return mergeParts(parts)
}

// quarter dome: half of the dome, cut on the z=0 plane (round side bulges +Z).
function buildQuarterSphere(r: number, seg: number, segY: number, t?: number): THREE.BufferGeometry {
  const halfSeg = Math.max(3, Math.round(seg / 2))
  const dome = (radius: number) =>
    scaleUv(new THREE.SphereGeometry(radius, halfSeg, segY, 0, Math.PI, 0, Math.PI / 2), Math.PI * r, (Math.PI / 2) * r)
  const parts: THREE.BufferGeometry[] = [dome(r)]
  const ri = Math.max(0.001, r - (t ?? 0))
  if (t !== undefined) {
    parts.push(flipInsideOut(dome(ri)))
    // bottom rim (half annulus at y=0, facing down) + vertical cut rim (half annulus in z=0, facing -Z)
    parts.push(scaleUv(new THREE.RingGeometry(ri, r, halfSeg, 1, 0, Math.PI).rotateX(Math.PI / 2), 2 * r, 2 * r))
    parts.push(flipInsideOut(scaleUv(new THREE.RingGeometry(ri, r, halfSeg, 1, 0, Math.PI), 2 * r, 2 * r)))
  } else {
    parts.push(scaleUv(new THREE.CircleGeometry(r, halfSeg, 0, Math.PI).rotateX(Math.PI / 2), 2 * r, 2 * r))
    parts.push(flipInsideOut(scaleUv(new THREE.CircleGeometry(r, halfSeg, 0, Math.PI), 2 * r, 2 * r)))
  }
  return mergeParts(parts)
}

// half column around Y (arc bulges +X, cut plane x=0). thickness → curved shell with
// straight rim strips; open drops the flat closures (end caps + chord/annuli).
function buildHalfCylinder(
  rt: number,
  rb: number,
  h: number,
  seg: number,
  t?: number,
  open?: boolean,
): THREE.BufferGeometry {
  const halfSeg = Math.max(3, Math.round(seg / 2))
  const cMax = Math.PI * Math.max(rt, rb)
  const tube = (top: number, bot: number) =>
    scaleUv(new THREE.CylinderGeometry(top, bot, h, halfSeg, 1, true, 0, Math.PI), cMax, h)
  const parts: THREE.BufferGeometry[] = [tube(rt, rb)]
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, w: number, v: number) => {
    // two triangles a-b-c, a-c-d with meters uv (w × v)
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray(), ...d.toArray()], 3),
    )
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, w, 0, w, v, 0, v], 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    g.computeVertexNormals()
    return g
  }
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  if (t !== undefined) {
    const rit = Math.max(0.001, rt - t)
    const rib = Math.max(0.001, rb - t)
    parts.push(flipInsideOut(tube(rit, rib)))
    // straight rim strips in the x=0 plane (θ=0 edge at +Z, θ=π edge at -Z), facing -X
    parts.push(quad(V(0, -h / 2, rib), V(0, -h / 2, rb), V(0, h / 2, rt), V(0, h / 2, rit), t, h))
    parts.push(quad(V(0, -h / 2, -rb), V(0, -h / 2, -rib), V(0, h / 2, -rit), V(0, h / 2, -rt), t, h))
    if (!open) {
      parts.push(
        scaleUv(
          new THREE.RingGeometry(rit, rt, halfSeg, 1, -Math.PI / 2, Math.PI)
            .rotateX(-Math.PI / 2)
            .translate(0, h / 2, 0),
          2 * rt,
          2 * rt,
        ),
      )
      parts.push(
        scaleUv(
          new THREE.RingGeometry(rib, rb, halfSeg, 1, -Math.PI / 2, Math.PI)
            .rotateX(Math.PI / 2)
            .translate(0, -h / 2, 0),
          2 * rb,
          2 * rb,
        ),
      )
    }
  } else if (!open) {
    // chord face (trapezoid for a frustum) facing -X + half-disk end caps
    parts.push(quad(V(0, -h / 2, -rb), V(0, -h / 2, rb), V(0, h / 2, rt), V(0, h / 2, -rt), 2 * Math.max(rt, rb), h))
    parts.push(
      scaleUv(
        new THREE.CircleGeometry(rt, halfSeg, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2).translate(0, h / 2, 0),
        2 * rt,
        2 * rt,
      ),
    )
    parts.push(
      scaleUv(
        new THREE.CircleGeometry(rb, halfSeg, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, -h / 2, 0),
        2 * rb,
        2 * rb,
      ),
    )
  }
  return mergeParts(parts)
}

// rectangular-profile bar swept along an arc in the XY plane ("rainbow": ends on y=0
// at x=±radius for the default 180°). size = [profile width (radial), depth (along Z)].
function buildArch(radius: number, w: number, d: number, arcDeg: number, seg: number): THREE.BufferGeometry {
  const arc = THREE.MathUtils.degToRad(arcDeg)
  const n = Math.max(4, Math.round(seg * (arc / Math.PI)))
  const ro = radius + w / 2
  const ri = radius - w / 2
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  // four longitudinal strips: outer (radial +), inner (radial -), front (z+), back (z-)
  const strip = (corner: (theta: number) => [THREE.Vector3, THREE.Vector3], v: number) => {
    const base = pos.length / 3
    for (let i = 0; i <= n; i++) {
      const th = (arc * i) / n
      const [a, b] = corner(th)
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      const u = radius * th
      uv.push(u, 0, u, v)
    }
    for (let i = 0; i < n; i++) {
      const o = base + i * 2
      index.push(o, o + 2, o + 1, o + 1, o + 2, o + 3)
    }
  }
  const P = (r: number, th: number, z: number) => new THREE.Vector3(r * Math.cos(th), r * Math.sin(th), z)
  strip((th) => [P(ro, th, -d / 2), P(ro, th, d / 2)], d) // outer, facing outward
  strip((th) => [P(ri, th, d / 2), P(ri, th, -d / 2)], d) // inner, facing the arc center
  strip((th) => [P(ro, th, d / 2), P(ri, th, d / 2)], w) // front (+Z)
  strip((th) => [P(ri, th, -d / 2), P(ro, th, -d / 2)], w) // back (-Z)
  // end caps at θ=0 and θ=arc
  const cap = (th: number, flip: boolean) => {
    const base = pos.length / 3
    const c = [P(ro, th, -d / 2), P(ro, th, d / 2), P(ri, th, d / 2), P(ri, th, -d / 2)]
    for (const p of c) pos.push(p.x, p.y, p.z)
    uv.push(0, 0, d, 0, d, w, 0, w)
    if (flip) index.push(base, base + 2, base + 1, base, base + 3, base + 2)
    else index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  cap(0, true)
  cap(arc, false)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return geo
}

// torus segment in the XY plane (arc from +X, counter-clockwise — 180° = upright
// rainbow), tube cross-section capped flat at both ends.
function buildTorusArc(r: number, tube: number, arcDeg: number, seg: number): THREE.BufferGeometry {
  const arc = THREE.MathUtils.degToRad(arcDeg)
  const ringSegs = Math.max(6, Math.round(seg * (arc / (Math.PI * 2))) * 2)
  const tubeSegs = Math.max(6, Math.min(12, Math.round((2 * Math.PI * tube) / ((2 * Math.PI * r) / seg))))
  const parts: THREE.BufferGeometry[] = [
    scaleUv(new THREE.TorusGeometry(r, tube, tubeSegs, ringSegs, arc), r * arc, 2 * Math.PI * tube),
  ]
  const cap = (th: number, up: boolean) =>
    scaleUv(
      new THREE.CircleGeometry(tube, tubeSegs)
        .rotateX(up ? -Math.PI / 2 : Math.PI / 2)
        .translate(r, 0, 0)
        .rotateZ(th),
      2 * tube,
      2 * tube,
    )
  parts.push(cap(0, false)) // start cap faces -Y (down, pre-rotation)
  parts.push(cap(arc, true)) // end cap faces the sweep direction
  return mergeParts(parts)
}

// ---------------------------------------------------------------------------
// Boolean modifiers (BAKE-time CSG, three-bvh-csg): the "modifier service" — feed a
// node's generated geometry + its `booleans` list, get the final geometry back. Each
// modifier is a generated shape placed in the node's local space. Runs on the RAW
// generated surfaces (before subdivide/craft), so the jitter pass afterwards roughens
// the cut edges — an authored hole gets the same hand-made irregularity as the rest.
// UVs are baked to meters on BOTH sides first (cut faces inherit the modifier's), and
// the result is a single group — a boolean node renders ONE material slot.
const CSG_OPS = { subtract: SUBTRACTION, union: ADDITION, intersect: INTERSECTION } as const
function applyBooleans(geo: THREE.BufferGeometry, mods: BooleanMod[]): THREE.BufferGeometry {
  const evaluator = new Evaluator()
  evaluator.useGroups = false // single-slot result — the cut inherits the node's material
  let brush = new Brush(geo)
  brush.updateMatrixWorld()
  for (const mod of mods) {
    const built = buildGeometry(mod as NodeDef)
    bakeUvsToMeters(built.geo, built.faces, mod as NodeDef)
    const mb = new Brush(built.geo)
    const [px, py, pz] = mod.pos ?? [0, 0, 0]
    const [rx, ry, rz] = mod.rot ?? [0, 0, 0]
    mb.position.set(px, py, pz)
    mb.rotation.set(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz))
    if (mod.scale !== undefined) {
      if (typeof mod.scale === 'number') mb.scale.setScalar(mod.scale)
      else mb.scale.set(mod.scale[0], mod.scale[1], mod.scale[2])
    }
    mb.updateMatrixWorld()
    const next = evaluator.evaluate(brush, mb, CSG_OPS[mod.op])
    brush.geometry.dispose()
    built.geo.dispose()
    brush = next
  }
  const out = brush.geometry
  out.clearGroups()
  return out
}

function buildGeometry(
  node: NodeDef,
  effCraft?: number,
  effSub?: number,
): { geo: THREE.BufferGeometry; faces: FaceRepeat[] } {
  // deforming nodes get aspect-corrected sources so triangles stay ~uniform
  const deforms = effCraft !== undefined || (effSub ?? 0) > 0
  switch (node.shape) {
    case 'plank': {
      const [w, h, d] = node.size as [number, number, number]
      // craft 1 = no baked jitter; the factory's entity-space pass jitters
      const geo = toBufferGeometry(generatePlank(w, h, d, 1, 0))
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'arrow': {
      // plank with its +x end sawn to an arrow point (signpost boards)
      const [w, h, d] = node.size as [number, number, number]
      const geo = toBufferGeometry(generateArrowPlank(w, h, d, 1, 0, node.tip))
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'star': {
      // beveled 3D n-point star in the XY plane (a point straight up) — every rim
      // vertex fans to front/back center apexes; depth = apex-to-apex thickness
      const r = node.radius!
      const geo = toBufferGeometry(
        generateStar(r, node.innerRatio ?? 0.45, node.points ?? 5, node.depth ?? r * 0.35, 1, 0),
      )
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'tree': {
      // recursive trunk/branches/twigs + leaf blobs; groups: 0 bark → 'side',
      // 1 leaves → 'top' (material: { side: bark_slot, top: leaf_slot }).
      // Seeded by craftSeed — every seed is a different tree; UVs already meters.
      const geo = toBufferGeometry(
        generateTree({
          height: node.height ?? 5,
          radius: node.radius ?? 0.18,
          lushness: node.lushness ?? 0.6,
          spread: node.spread ?? 45,
          thickness: node.thickness ?? 0.6,
          leafSize: node.leafSize ?? 0.5,
          seed: node.craftSeed ?? 1,
        }),
      )
      return {
        geo,
        faces: [
          { face: 'side', su: 1, sv: 1 },
          { face: 'top', su: 1, sv: 1 },
        ],
      }
    }
    case 'post': {
      const rt = node.radiusTop ?? node.radius!
      const rb = node.radiusBottom ?? node.radius!
      const geo = toBufferGeometry(generatePost(rt, rb, node.height!, node.segments ?? 18, 1, 0))
      // groups match cylinder order: side / top / bottom (per-face slots work)
      return {
        geo,
        faces: [
          { face: 'side', su: 1, sv: 1 },
          { face: 'top', su: 1, sv: 1 },
          { face: 'bottom', su: 1, sv: 1 },
        ],
      }
    }
    case 'ring': {
      const rt = node.radiusTop ?? node.radius!
      const rb = node.radiusBottom ?? node.radius!
      const h = node.height!
      const geo = toBufferGeometry(generateRing(rt, rb, h, node.thickness!, node.segments ?? 20, 1, 0))
      const r = Math.max(rt, rb)
      return {
        geo,
        faces: [
          { face: 'side', su: 2 * Math.PI * r, sv: h },
          { face: 'top', su: 2 * r, sv: 2 * r },
          { face: 'bottom', su: 2 * r, sv: 2 * r },
        ],
      }
    }
    case 'box': {
      const [w, h, d] = node.size as [number, number, number]
      const m = Math.min(w, h, d)
      const geo = deforms
        ? new THREE.BoxGeometry(w, h, d, aspectSegs(w, m), aspectSegs(h, m), aspectSegs(d, m))
        : new THREE.BoxGeometry(w, h, d)
      return {
        geo,
        faces: [
          { face: 'right', su: d, sv: h },
          { face: 'left', su: d, sv: h },
          { face: 'top', su: w, sv: d },
          { face: 'bottom', su: w, sv: d },
          { face: 'front', su: w, sv: h },
          { face: 'back', su: w, sv: h },
        ],
      }
    }
    case 'cylinder': {
      const rt = node.radiusTop ?? node.radius!
      const rb = node.radiusBottom ?? node.radius!
      const h = node.height!
      // uniform-density tube: side rings + concentric-ring caps (no dense fans)
      const geo = toBufferGeometry(
        generateTube(rt, rb, h, node.segments ?? 24, { open: node.open ?? false, bulge: node.bulge }),
      )
      const r = Math.max(rt, rb)
      const c = 2 * Math.PI * r
      const sideFaces: FaceRepeat[] = [{ face: 'side', su: c, sv: h }]
      return {
        geo,
        faces: node.open
          ? sideFaces
          : [...sideFaces, { face: 'top', su: 2 * r, sv: 2 * r }, { face: 'bottom', su: 2 * r, sv: 2 * r }],
      }
    }
    case 'cone': {
      const r = node.radius!,
        h = node.height!
      const geo = toBufferGeometry(generateTube(0, r, h, node.segments ?? 24, {}))
      return {
        geo,
        faces: [
          { face: 'side', su: 2 * Math.PI * r, sv: Math.hypot(r, h) },
          { face: 'bottom', su: 2 * r, sv: 2 * r },
        ],
      }
    }
    case 'sphere': {
      const r = node.radius!
      const seg = node.segments ?? 24
      // heightSegs = widthSegs/2: meridian edge length matches the equator's.
      // segmentsY overrides when a silhouette needs more vertical loops (rock
      // boulders, mushroom caps) without densifying the radial facets.
      const geo = new THREE.SphereGeometry(r, seg, node.segmentsY ?? Math.max(3, Math.round(seg * 0.5)))
      return { geo, faces: [{ face: 'all', su: 2 * Math.PI * r, sv: Math.PI * r }] }
    }
    case 'torus': {
      const r = node.radius!,
        t = node.tube!
      // tube segments from the tube/ring circumference ratio — uniform quads
      const ringSegs = node.segments ?? 24
      const tubeSegs = Math.max(6, Math.min(12, Math.round((2 * Math.PI * t) / ((2 * Math.PI * r) / ringSegs))))
      const geo = new THREE.TorusGeometry(r, t, tubeSegs, ringSegs)
      geo.rotateX(Math.PI / 2) // lie flat, ring axis = Y (crown/rim orientation)
      return { geo, faces: [{ face: 'all', su: 2 * Math.PI * r, sv: 2 * Math.PI * t }] }
    }
    case 'capsule': {
      const r = node.radius!,
        h = node.height!
      const geo = new THREE.CapsuleGeometry(r, h, 8, node.segments ?? 20)
      return { geo, faces: [{ face: 'all', su: 2 * Math.PI * r, sv: h + Math.PI * r }] }
    }
    // half/quarter primitives + arch: UVs pre-baked to METERS by the builders
    // (su/sv 1 like the generated lumber) — one 'all' group, single slot.
    case 'halfSphere': {
      const r = node.radius!,
        seg = node.segments ?? 24
      const geo = buildHalfSphere(r, seg, node.segmentsY ?? Math.max(2, Math.round(seg / 4)), node.thickness)
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'quarterSphere': {
      const r = node.radius!,
        seg = node.segments ?? 24
      const geo = buildQuarterSphere(r, seg, node.segmentsY ?? Math.max(2, Math.round(seg / 4)), node.thickness)
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'halfCylinder': {
      const rt = node.radiusTop ?? node.radius!
      const rb = node.radiusBottom ?? node.radius!
      const geo = buildHalfCylinder(rt, rb, node.height!, node.segments ?? 24, node.thickness, node.open)
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'arch': {
      const [w, d] = node.size as [number, number]
      const geo = buildArch(node.radius!, w, d, node.arc ?? 180, node.segments ?? 24)
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'halfTorus': {
      const geo = buildTorusArc(node.radius!, node.tube!, node.arc ?? 180, node.segments ?? 24)
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'quarterTorus': {
      const geo = buildTorusArc(node.radius!, node.tube!, node.arc ?? 90, node.segments ?? 24)
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'plane':
    case 'cross': {
      const [w, h] = node.size as [number, number]
      const m = Math.min(w, h)
      const geo = deforms
        ? new THREE.PlaneGeometry(w, h, aspectSegs(w, m), aspectSegs(h, m))
        : new THREE.PlaneGeometry(w, h)
      return { geo, faces: [{ face: 'all', su: w, sv: h }] }
    }
    case 'decal': {
      // sprite quad: the embedded image maps ONCE across the face (0..1 UVs — su/sv 1 makes
      // bakeUvsToMeters a no-op, so it never tiles). Flat, never subdivided/jittered.
      const [w, h] = node.size as [number, number]
      return { geo: new THREE.PlaneGeometry(w, h), faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'disk': {
      // single flat circular face (+Y), no rim/underside — container floors etc.
      const r = node.radius!
      const geo = toBufferGeometry(generateDisk(r, node.segments ?? 20, 1, 0))
      return { geo, faces: [{ face: 'all', su: 2 * r, sv: 2 * r }] }
    }
    case 'mesh': {
      const geo = getMeshGeometry(node.mesh!)
      if (!geo) throw new Error(`mesh not preloaded: ${node.mesh} (call preloadEntityMeshes first)`)
      // external meshes use their own UVs — never retiled (see applyUvTiling)
      return { geo: geo.clone(), faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    default:
      throw new Error(`unknown shape ${node.shape}`)
  }
}

// The render-relevant fields the LOAD path reads off a node. Both the rig node
// (NodeDef) and a baked node (BakedNode) satisfy it — so once these are baked into
// the geom tree, buildEntity/loadNodeMeshes drive off the baked node alone and
// never touch the rig for structure. (Material DEFINITIONS still come from the main
// file's `materials`, keyed by the slot names carried here.)
type RenderNode = Pick<NodeDef, 'shape' | 'material' | 'image'>

// group index -> face key mapping for the shapes that carry geometry groups
function groupFacesOf(node: RenderNode): readonly FaceKey[] {
  switch (node.shape) {
    case 'box':
      return BOX_GROUP_FACES
    case 'cylinder':
    case 'post':
    case 'ring':
    case 'tree': // 0 bark → side, 1 leaves → top
      return CYL_GROUP_FACES
    case 'cone':
      return CONE_GROUP_FACES
    default:
      return ['all']
  }
}

// UV projection (the material slot's uvProject): re-project UVs in ENTITY space,
// after build/subdivide/jitter.
// box = dominant-axis planar per triangle (needs a non-indexed soup), planar =
// XZ from above, sphere = spherical around the node's bbox center. Raw coords
// come out in meters, then the existing uvMode/uvScale metering applies per
// material group (tile = repeats/m, fit = whole repeats, stretch = normalized).
// The pure projection CORE: rewrite `geo`'s uv attribute in the chosen mode using
// entity-space positions (geo positions transformed by `matrix`). Leaves UVs in
// METERS (metering is layered on separately). Box mode requires non-indexed geo
// (per-triangle axis pick) so it returns a possibly-new geometry and disposes the
// old one. Shared verbatim by the factory (entity render) AND the material-manager
// preview (#13) so the preview's projection is WYSIWYG-identical to the prop.
export function projectGeometryUv(
  geo: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  mode: 'box' | 'planar' | 'sphere',
): THREE.BufferGeometry {
  let g = geo
  if (mode === 'box' && g.index) {
    g = g.toNonIndexed()
    geo.dispose()
  }
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count
  if (!g.getAttribute('uv') || (g.getAttribute('uv') as THREE.BufferAttribute).count !== n)
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
  const uv = g.getAttribute('uv') as THREE.BufferAttribute

  // entity-space positions + bbox
  const pts = new Float32Array(n * 3)
  const v = new THREE.Vector3()
  const bb = new THREE.Box3()
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix)
    pts[i * 3] = v.x
    pts[i * 3 + 1] = v.y
    pts[i * 3 + 2] = v.z
    bb.expandByPoint(v)
  }
  const size = bb.getSize(new THREE.Vector3())
  const center = bb.getCenter(new THREE.Vector3())

  if (mode === 'planar') {
    // straight down: u = x, v = -z (texture reads upright from above)
    for (let i = 0; i < n; i++) uv.setXY(i, pts[i * 3], -pts[i * 3 + 2])
  } else if (mode === 'sphere') {
    // angles scaled to meters by the mean radius so tile density matches
    const r = Math.max((size.x + size.y + size.z) / 6, 1e-3)
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 3] - center.x
      const dy = pts[i * 3 + 1] - center.y
      const dz = pts[i * 3 + 2] - center.z
      const len = Math.max(Math.hypot(dx, dy, dz), 1e-9)
      const u01 = Math.atan2(dx, dz) / (2 * Math.PI) + 0.5
      const v01 = 1 - Math.acos(Math.min(1, Math.max(-1, dy / len))) / Math.PI
      uv.setXY(i, u01 * 2 * Math.PI * r, v01 * Math.PI * r)
    }
  } else {
    // box: per triangle, project along the dominant axis of its normal — SIGNED.
    // The facing direction picks the u sign so the texture reads left-to-right from
    // OUTSIDE on every face (+X: u=-z, -X: u=+z, +Z: u=+x, -Z: u=-x; ±Y mirror v).
    // With a single |abs| convention two of the four side quadrants rendered the
    // texture horizontally MIRRORED, and every boundary between a correct and a
    // flipped region showed as a reflect-seam on round box-projected walls.
    for (let t = 0; t + 2 < n; t += 3) {
      const ax = pts[t * 3],
        ay = pts[t * 3 + 1],
        az = pts[t * 3 + 2]
      const e1x = pts[(t + 1) * 3] - ax,
        e1y = pts[(t + 1) * 3 + 1] - ay,
        e1z = pts[(t + 1) * 3 + 2] - az
      const e2x = pts[(t + 2) * 3] - ax,
        e2y = pts[(t + 2) * 3 + 1] - ay,
        e2z = pts[(t + 2) * 3 + 2] - az
      const snx = e1y * e2z - e1z * e2y
      const sny = e1z * e2x - e1x * e2z
      const snz = e1x * e2y - e1y * e2x
      const nx = Math.abs(snx),
        ny = Math.abs(sny),
        nz = Math.abs(snz)
      const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2
      const sign = (axis === 0 ? snx : axis === 1 ? sny : snz) < 0 ? -1 : 1
      for (let k = 0; k < 3; k++) {
        const i = t + k
        const x = pts[i * 3],
          y = pts[i * 3 + 1],
          z = pts[i * 3 + 2]
        if (axis === 0) uv.setXY(i, -sign * z, y)
        else if (axis === 1) uv.setXY(i, x, -sign * z)
        else uv.setXY(i, sign * x, y)
      }
    }
  }
  uv.needsUpdate = true
  return g
}

function applyUvProjection(
  geo: THREE.BufferGeometry,
  node: RenderNode,
  materials: Record<string, ResolvedMaterialDef>,
  matrix: THREE.Matrix4,
  mode: 'box' | 'planar' | 'sphere',
): THREE.BufferGeometry {
  const g = projectGeometryUv(geo, matrix, mode)
  const uv = g.getAttribute('uv') as THREE.BufferAttribute

  // metering per material group (raw UVs are meters at this point) — the SAME
  // meterGroupUVs the tiling path uses, so uvMode/uvScale (slot AND material
  // default) always compose with the projection (#32).
  const faces = groupFacesOf(node)
  const groups = g.groups.length ? g.groups : [{ start: 0, count: indexCount(g), materialIndex: 0 }]
  for (const grp of groups) {
    const def = materials[resolveFaceSlot(node.material, faces[grp.materialIndex ?? 0] ?? 'all')]
    if (!def) continue
    const count = grp.count === Infinity ? indexCount(g) - grp.start : grp.count
    const verts = groupVerts(g, grp.start, count)
    meterGroupUVs(uv, verts, ...uvModesOf(def.uvMode), effectiveUvScale(def))
    rotateGroupUVs(uv, verts, def.uvRot) // baked texture direction (see rotateGroupUVs)
  }
  uv.needsUpdate = true
  // box mode passed through non-indexed soup (per-triangle axis pick) — re-weld to
  // indexed now that the final UVs are written, so the merge/batch pool stays compact
  if (!g.getIndex()) {
    const welded = weldedToBuffer(weldGeometryExact(g), !!g.getAttribute('normal'), true)
    g.dispose()
    return welded
  }
  return g
}

// The UV projection to use for a node. SINGLE SOURCE: the material slot's uvProject
// (doc.materials[slot].uvProject, resolved through the inherit chain). 'none' =
// explicit "keep authored/tiled UVs"; absent = default (no projection). Never for
// meshes (authored atlas UVs). Projection is no longer a rig/node concern.
function effectiveUvProject(
  node: RenderNode,
  materials: Record<string, ResolvedMaterialDef>,
): 'box' | 'planar' | 'sphere' | undefined {
  if (node.shape === 'mesh') return undefined
  const slots = !node.material ? [] : typeof node.material === 'string' ? [node.material] : Object.values(node.material)
  for (const slot of slots) {
    if (!slot) continue
    const p = materials[slot]?.uvProject
    if (p) return p === 'none' ? undefined : p
  }
  return undefined
}

// BAKE step 1: convert a freshly-generated geometry's authored UVs to METERS
// (built-ins author 0..1 with the face world-size in faces[gi].su/sv; generated
// lumber is already meters, su=sv=1). Material-independent — the per-material
// metering (uvMode/uvScale/uvRot) is deferred to load so it stays live. Shape
// "mesh" keeps its authored atlas UVs untouched.
function bakeUvsToMeters(geo: THREE.BufferGeometry, faces: FaceRepeat[], node: NodeDef): void {
  if (node.shape === 'mesh') return
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  if (!uv) return
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: indexCount(geo), materialIndex: 0 }]
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const f = faces[gi] ?? faces[0]
    if (!f || (f.su === 1 && f.sv === 1)) continue
    const count = g.count === Infinity ? indexCount(geo) - g.start : g.count
    for (const vi of groupVerts(geo, g.start, count)) uv.setXY(vi, uv.getX(vi) * f.su, uv.getY(vi) * f.sv)
  }
  uv.needsUpdate = true
}

// LOAD steps 2+3 (non-projected path): meter the (already-meters) baked UVs by
// uvMode + effective uvScale, then bake the slot's uvRot. Face keys derive from
// the shape's group order (groupFacesOf). Shape "mesh" keeps atlas UVs (uvRot only).
function meterBakedUvs(
  geo: THREE.BufferGeometry,
  node: RenderNode,
  materials: Record<string, ResolvedMaterialDef>,
): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  if (!uv) return
  const retile = node.shape !== 'mesh'
  const faceKeys = groupFacesOf(node)
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: indexCount(geo), materialIndex: 0 }]
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const def = materials[resolveFaceSlot(node.material, faceKeys[gi] ?? faceKeys[0] ?? 'all')]
    if (!def) continue
    if (!retile && !def.uvRot) continue
    const count = g.count === Infinity ? indexCount(geo) - g.start : g.count
    const verts = groupVerts(geo, g.start, count)
    if (retile) meterGroupUVs(uv, verts, ...uvModesOf(def.uvMode), effectiveUvScale(def)) // UVs already in meters
    rotateGroupUVs(uv, verts, def.uvRot)
  }
  uv.needsUpdate = true
}

// Exact weld: collapse corners with a fully identical quantized (pos, normal, uv)
// tuple into shared indexed vertices — lossless (nothing visually distinct merges)
// and coordinates settle to ≤5 decimals instead of float64 round-trip noise. The
// weld is scoped PER GROUP: UV metering mutates uvs group-by-group (meterGroupUVs),
// so a vertex may never be shared across two groups. Output group ranges are
// corner-domain (= index entries), corners repacked in group-iteration order.
// Used by the BAKE (extractGeom → sidecar) and by box UV projection at load, which
// has to pass through non-indexed soup (per-triangle axis pick) and re-welds after.
const Q_POS = 1e5 // 0.01 mm
const Q_NRM = 1e4
const quant = (v: number, s: number) => Math.round(v * s) / s || 0 // ||0 folds -0
interface WeldedArrays {
  positions: number[]
  normals: number[]
  uvs: number[]
  index: number[]
  groups: [number, number, number][]
}
function weldGeometryExact(geo: THREE.BufferGeometry): WeldedArrays {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  const idx = geo.getIndex()
  const corners = idx ? idx.count : pos.count
  const srcGroups = (geo.groups.length ? geo.groups : [{ start: 0, count: corners, materialIndex: 0 }]).map(
    (g) =>
      [g.start, g.count === Infinity ? corners - g.start : g.count, g.materialIndex ?? 0] as [number, number, number],
  )
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const index: number[] = []
  const groups: [number, number, number][] = []
  for (const [start, count, mi] of srcGroups) {
    groups.push([index.length, count, mi])
    const seen = new Map<string, number>()
    for (let c = start; c < start + count; c++) {
      const i = idx ? idx.getX(c) : c
      const px = quant(pos.getX(i), Q_POS),
        py = quant(pos.getY(i), Q_POS),
        pz = quant(pos.getZ(i), Q_POS)
      const nx = nrm ? quant(nrm.getX(i), Q_NRM) : 0,
        ny = nrm ? quant(nrm.getY(i), Q_NRM) : 0,
        nz = nrm ? quant(nrm.getZ(i), Q_NRM) : 0
      const tu = uv ? quant(uv.getX(i), Q_POS) : 0,
        tv = uv ? quant(uv.getY(i), Q_POS) : 0
      const key = `${px},${py},${pz},${nx},${ny},${nz},${tu},${tv}`
      let vi = seen.get(key)
      if (vi === undefined) {
        vi = positions.length / 3
        seen.set(key, vi)
        positions.push(px, py, pz)
        if (nrm) normals.push(nx, ny, nz)
        if (uv) uvs.push(tu, tv)
      }
      index.push(vi)
    }
  }
  return { positions, normals, uvs, index, groups }
}
function weldedToBuffer(w: WeldedArrays, hasNrm: boolean, hasUv: boolean): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(w.positions, 3))
  if (hasNrm) geo.setAttribute('normal', new THREE.Float32BufferAttribute(w.normals, 3))
  if (hasUv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(w.uvs, 2))
  geo.setIndex(w.index)
  for (const [start, count, mi] of w.groups) geo.addGroup(start, count, mi)
  return geo
}

// serialize a built geometry into the stored form / rebuild it back. Bake v9
// sidecars are the welded indexed form.
function extractGeom(geo: THREE.BufferGeometry): BakedNodeGeom {
  const w = weldGeometryExact(geo)
  return { positions: w.positions, normals: w.normals, uv: w.uvs, index: w.index, groups: w.groups }
}
function bakedGeomToBuffer(b: BakedNodeGeom): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3))
  if (b.normals.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3))
  if (b.uv.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2)) // a UV-less mesh keeps none (matches the old path)
  if (b.index.length) geo.setIndex(b.index)
  for (const [start, count, mi] of b.groups) geo.addGroup(start, count, mi)
  if (!b.normals.length) computeCreasedNormals(geo) // legacy sidecar without stored normals
  return geo
}

// entity-space transform for a node — the SAME formula buildEntity's buildNode
// uses (outer[pos+pivot, rot, scale] × inner[-pivot]), so the craft jitter baked
// through it lines up with the live tree and seams between nodes stay sealed.
function composeNodeMatrix(node: NodeDef, rot: readonly number[], parentMatrix: THREE.Matrix4): THREE.Matrix4 {
  const pivot = node.pivot ?? [0, 0, 0]
  const pos = node.pos ?? [0, 0, 0]
  const outer = new THREE.Object3D()
  outer.position.set(pos[0] + pivot[0], pos[1] + pivot[1], pos[2] + pivot[2])
  outer.rotation.set(
    THREE.MathUtils.degToRad(rot[0]),
    THREE.MathUtils.degToRad(rot[1]),
    THREE.MathUtils.degToRad(rot[2]),
  )
  if (node.scale !== undefined) {
    if (typeof node.scale === 'number') outer.scale.setScalar(node.scale)
    else outer.scale.set(node.scale[0], node.scale[1], node.scale[2])
  }
  outer.updateMatrix()
  const inner = new THREE.Object3D()
  inner.position.set(-pivot[0], -pivot[1], -pivot[2])
  inner.updateMatrix()
  return new THREE.Matrix4().multiplyMatrices(parentMatrix, outer.matrix).multiply(inner.matrix)
}

// doubleWall bake: duplicate every triangle with REVERSED winding + flipped normals,
// so the surface is real geometry on BOTH sides. Group-aware — each group's count
// doubles in place (materialIndex preserved), so the per-face material mapping and UV
// metering at load are untouched. Lets an open/thin part read two-sided under a
// SINGLE-SIDED material (which then merges). ~2× the part's triangles (cheap).
function foldBackfaces(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo
  const pos = src.getAttribute('position') as THREE.BufferAttribute
  const nrm = src.getAttribute('normal') as THREE.BufferAttribute | null
  const uv = src.getAttribute('uv') as THREE.BufferAttribute | null
  const vertCount = pos.count
  const srcGroups = src.groups.length ? src.groups : [{ start: 0, count: vertCount, materialIndex: 0 }]
  const outPos: number[] = [],
    outNrm: number[] = [],
    outUv: number[] = []
  const out = new THREE.BufferGeometry()
  const push = (i: number, flip: boolean) => {
    outPos.push(pos.getX(i), pos.getY(i), pos.getZ(i))
    if (nrm)
      outNrm.push(
        flip ? -nrm.getX(i) : nrm.getX(i),
        flip ? -nrm.getY(i) : nrm.getY(i),
        flip ? -nrm.getZ(i) : nrm.getZ(i),
      )
    if (uv) outUv.push(uv.getX(i), uv.getY(i))
  }
  for (const g of srcGroups) {
    const count = g.count === Infinity ? vertCount - g.start : g.count
    const start = outPos.length / 3
    for (let i = g.start; i < g.start + count; i++) push(i, false) // originals
    for (let t = g.start; t < g.start + count; t += 3) {
      push(t, true)
      push(t + 2, true)
      push(t + 1, true)
    } // reversed
    out.addGroup(start, count * 2, g.materialIndex ?? 0)
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  if (outNrm.length) out.setAttribute('normal', new THREE.Float32BufferAttribute(outNrm, 3))
  if (outUv.length) out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
  if (src !== geo) src.dispose()
  return out
}

// BAKE one node's geometry (STUDIO/tool only): generate → booleans (CSG) →
// subdivide → craft jitter (entity-space, seeded per variant) → UVs-to-meters →
// doubleWall fold → serialize. Returns null for a mesh whose FBX isn't preloaded.
// effCraft/effSub are the EFFECTIVE generation options after rig-tree inheritance
// (caller resolves own ?? nearest ancestor) — this function never reads node.craft/sub.
function bakeNodeGeometry(
  node: NodeDef,
  matrix: THREE.Matrix4,
  jitterSeed: number,
  effCraft?: number,
  effSub?: number,
): BakedNodeGeom | null {
  if (node.shape === 'mesh') {
    const g = getMeshGeometry(node.mesh!)
    return g ? extractGeom(g.clone()) : null
  }
  if (node.shape === 'decal') {
    // sprite quad, used verbatim: no subdivision, no craft jitter (the image must not warp),
    // no UV metering (0..1 across the face), no doubleWall.
    return extractGeom(buildGeometry(node).geo)
  }
  const built = buildGeometry(node, effCraft, effSub)
  let geo = built.geo
  let faces = built.faces
  if (node.booleans?.length) {
    // meters BEFORE the cut (both sides), then CSG; the later metering no-ops (su/sv 1).
    // Jitter still runs after — cut edges get the same hand-made roughness.
    bakeUvsToMeters(geo, faces, node)
    geo = applyBooleans(geo, node.booleans)
    faces = [{ face: 'all', su: 1, sv: 1 }]
  }
  const generated = GENERATED_SHAPES.has(node.shape)
  if (!generated) {
    const sub = effSub ?? 0
    if (sub > 0) {
      const coarse = geo
      geo = subdivideGeometry(geo, sub)
      coarse.dispose()
    }
  }
  const craft = effCraft ?? (generated ? 0.5 : undefined)
  if (craft !== undefined) applyCraftJitter(geo, craft, matrix, jitterSeed)
  bakeUvsToMeters(geo, faces, node)
  if (node.doubleWall) {
    const folded = foldBackfaces(geo)
    geo.dispose()
    geo = folded
  }
  return extractGeom(geo)
}

// LOAD one node's render meshes from its BAKED geometry (runtime + studio): the
// cheap live steps only — UV metering/projection + uvRot (so material edits show
// without a re-bake) and per-face material assignment. "cross" → two meshes.
function loadNodeMeshes(
  nodeName: string,
  node: RenderNode,
  bakedGeom: BakedNodeGeom,
  slotMaterials: Map<string, EntityMaterial>,
  materials: Record<string, ResolvedMaterialDef>,
  nodeMatrix: THREE.Matrix4,
): THREE.Mesh[] {
  let geo = bakedGeomToBuffer(bakedGeom)
  // decal: the sprite quad renders its EMBEDDED image with plain 0..1 UVs — no slot
  // material, no metering/projection (both would re-tile the image), no per-face split.
  if (node.shape === 'decal') {
    const mesh = new THREE.Mesh(geo, makeDecalMaterial(node.image ?? ''))
    mesh.userData.nodeName = nodeName
    mesh.userData.slotByIndex = ['']
    return [mesh] // decals: stickers on a surface — no shadow casting/receiving
  }
  const projectMode = effectiveUvProject(node, materials)
  if (projectMode !== undefined) geo = applyUvProjection(geo, node, materials, nodeMatrix, projectMode)
  else meterBakedUvs(geo, node, materials)

  const slotFor = (face: FaceKey) => slotMaterials.get(resolveFaceSlot(node.material, face))!
  let material: THREE.Material | THREE.Material[]
  let slotByIndex: string[]
  if (node.shape === 'box') {
    material = BOX_GROUP_FACES.map((f) => slotFor(f))
    slotByIndex = BOX_GROUP_FACES.map((f) => resolveFaceSlot(node.material, f))
  } else if (node.shape === 'cylinder' || node.shape === 'post' || node.shape === 'ring' || node.shape === 'tree') {
    material = CYL_GROUP_FACES.map((f) => slotFor(f))
    slotByIndex = CYL_GROUP_FACES.map((f) => resolveFaceSlot(node.material, f))
  } else if (node.shape === 'cone') {
    material = CONE_GROUP_FACES.map((f) => slotFor(f))
    slotByIndex = CONE_GROUP_FACES.map((f) => resolveFaceSlot(node.material, f))
  } else {
    material = slotFor('all')
    slotByIndex = [resolveFaceSlot(node.material, 'all')]
  }

  const meshes: THREE.Mesh[] = []
  const count = node.shape === 'cross' ? 2 : 1
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(i === 0 ? geo : geo.clone(), material)
    if (i === 1) mesh.rotation.y = Math.PI / 2
    mesh.userData.nodeName = nodeName
    mesh.userData.slotByIndex = slotByIndex
    mesh.castShadow = true
    mesh.receiveShadow = true
    meshes.push(mesh)
  }
  return meshes
}

// A variant's LAYOUT — stored in <id>.variants.json, one entry per variant. FULLY
// RESOLVED, declarative data: the flat set of parts PRESENT in this variant (oneOf
// picks + chance already resolved — dropped parts simply aren't listed), each with
// its final local position + rotation (rotJitter already rolled in). NO logic
// operators — the composer just reads `parts` and places them. Rolled ONCE
// ("Regenerate variants"); a craft edit re-composes the same layouts, so the
// arrangement never shuffles under you.
export interface VariantLayout {
  parts: Record<string, { pos: [number, number, number]; rot: [number, number, number] }>
}

const randSeed = () => (Math.random() * 0x7fffffff) | 0

function shapedNodes(doc: EntityDoc): [string, NodeDef][] {
  const out: [string, NodeDef][] = []
  walkRig(doc.rig ?? {}, (name, node) => {
    if (node.shape) out.push([name, node])
  })
  return out
}

// Roll ONE variant layout, RESOLVING all structure to plain data (the only place
// oneOf/chance/rotJitter randomness runs). oneOf keeps one node per group; chance
// drops a node + its subtree; every surviving node is recorded with its final local
// pos + rot (rotJitter rolled in). The stored result carries no operators.
function rollLayout(doc: EntityDoc, rng: () => number): VariantLayout {
  const drop = new Set<string>()
  for (const names of Object.values(doc.variants?.oneOf ?? {})) {
    const keep = names[Math.floor(rng() * names.length) % names.length]
    for (const n of names) if (n !== keep) drop.add(n)
  }
  const parts: VariantLayout['parts'] = {}
  const walk = (name: string, node: NodeDef): void => {
    if (drop.has(name)) return // oneOf loser
    if (node.chance !== undefined && rng() > node.chance) return // chance drop (subtree gone)
    const bp = node.pos ?? [0, 0, 0]
    const br = node.rot ?? [0, 0, 0]
    const rot: [number, number, number] = node.rotJitter
      ? [
          br[0] + randRange(rng, -node.rotJitter[0], node.rotJitter[0]),
          br[1] + randRange(rng, -node.rotJitter[1], node.rotJitter[1]),
          br[2] + randRange(rng, -node.rotJitter[2], node.rotJitter[2]),
        ]
      : [br[0], br[1], br[2]]
    parts[name] = { pos: [bp[0], bp[1], bp[2]], rot }
    for (const [cn, cd] of Object.entries(node.children ?? {})) walk(cn, cd)
  }
  for (const [name, node] of Object.entries(doc.rig ?? {})) walk(name, node)
  return { parts }
}

// Roll layouts (STUDIO/tool) — `n` of them, default = the doc's variant count. A
// partial `n` APPENDS layouts when count grows, leaving existing ones untouched.
// Persisted to <id>.variants.json.
export function bakeVariantLayouts(doc: EntityDoc, n = Math.max(1, doc.variants?.count ?? 1)): VariantLayout[] {
  return Array.from({ length: Math.max(0, n) }, () => rollLayout(doc, Math.random))
}

// Generate EVERY shaped node's geometry ONCE (STUDIO/tool), in its BASE pose
// (node.rot — no rotJitter), so a part is variant-independent and can compose into
// any layout. Craft jitter runs in base entity space with the node's craftSeed;
// seam-group members share a seed so their coincident base-pose vertices seal.
// (rotJitter is a rigid transform applied later at compose/build, not baked in.)
// craft/sub INHERIT down the rig tree (like material slot inheritance, but the
// hierarchy is the rig itself): a node without its own value uses the nearest
// ancestor's; setting its own overrides for it and its subtree.
function bakeParts(doc: EntityDoc): Record<string, BakedNodeGeom> {
  const parts: Record<string, BakedNodeGeom> = {}
  const walk = (name: string, node: NodeDef, parentMatrix: THREE.Matrix4, inhCraft?: number, inhSub?: number): void => {
    const matrix = composeNodeMatrix(node, node.rot ?? [0, 0, 0], parentMatrix)
    const craft = node.craft ?? inhCraft
    const sub = node.sub ?? inhSub
    if (node.shape) {
      const g = bakeNodeGeometry(node, matrix, node.craftSeed ?? 0, craft, sub)
      if (g) parts[name] = g
    }
    for (const [cn, cd] of Object.entries(node.children ?? {})) walk(cn, cd, matrix, craft, sub)
  }
  const identity = new THREE.Matrix4()
  for (const [name, node] of Object.entries(doc.rig ?? {})) walk(name, node, identity)
  return parts
}

// Compose one variant into a self-contained scene tree by READING the resolved
// layout: for each part the layout lists, emit a baked node carrying the rig's
// render fields + the layout's final pos/rot + the once-baked geometry, and nest
// its surviving children. A node absent from layout.parts is dropped with its whole
// subtree. The result needs nothing from the rig at runtime.
function composeVariant(doc: EntityDoc, parts: Record<string, BakedNodeGeom>, layout: VariantLayout): BakedVariant {
  // nodes whose layout ABSENCE is meaningful (dropped by the roll) vs. nodes simply
  // added after the layouts were rolled (see below)
  const oneOfNames = new Set<string>()
  for (const group of Object.values(doc.variants?.oneOf ?? {})) for (const n of group) oneOfNames.add(n)
  const build = (name: string, node: NodeDef): BakedNode | null => {
    let p = layout.parts[name]
    if (!p) {
      // Absent from the stored layout. For a RANDOMIZED node (chance / oneOf member /
      // rotJitter) that means "dropped by the roll" — stay dropped. A DETERMINISTIC node
      // was simply authored AFTER the layouts were rolled: compose it at its base pose —
      // exactly what a fresh roll would emit — so hand-authored additions (decals, new
      // parts) appear without regenerating (= reshuffling) the stored variants.
      if (node.chance !== undefined || node.rotJitter !== undefined || oneOfNames.has(name)) return null
      p = {
        pos: (node.pos ?? [0, 0, 0]) as [number, number, number],
        rot: (node.rot ?? [0, 0, 0]) as [number, number, number],
      }
    }
    const entry: BakedNode = { pos: p.pos, rot: p.rot }
    if (node.scale !== undefined) entry.scale = node.scale
    if (node.pivot !== undefined) entry.pivot = node.pivot
    if (node.hidden) entry.hidden = true
    if (node.shape !== undefined) entry.shape = node.shape
    if (node.material !== undefined) entry.material = node.material
    if (node.image !== undefined) entry.image = node.image // decal sprite rides into the sidecar
    if (node.shape && parts[name]) entry.geom = parts[name]
    const children: Record<string, BakedNode> = {}
    for (const [cn, cd] of Object.entries(node.children ?? {})) {
      const child = build(cn, cd)
      if (child) children[cn] = child
    }
    if (Object.keys(children).length) entry.children = children
    return entry
  }
  const nodes: Record<string, BakedNode> = {}
  for (const [name, node] of Object.entries(doc.rig ?? {})) {
    const b = build(name, node)
    if (b) nodes[name] = b
  }
  return { nodes }
}

// Compose the full baked geometry set (STUDIO/tool): parts baked once × the given
// layouts (or freshly rolled ones — the lineup path passes none). Deterministic in
// (craftSeeds, layouts): re-baking after a craft edit reproduces it exactly.
// (Per-vertex AO baking lived here in bake v5–v6 — retired in favor of GTAO; the
// tracer/BVH survives in ao.ts for future baked-map/lightmap work.)
export function bakeEntityGeometry(doc: EntityDoc, layouts?: VariantLayout[]): BakedGeometry {
  const parts = bakeParts(doc)
  return (layouts ?? bakeVariantLayouts(doc)).map((l) => composeVariant(doc, parts, l))
}

// ---------------------------------------------------------------------------
// Per-part craft seeds. Stored on each shaped rig node (craftSeed) so craft is
// reproducible AND individually re-rollable. Two nodes that share a base-pose
// vertex (a real seam — rare, only frame corners) MUST share a seed or the seam
// cracks when jittered; computeSeamGroups finds them and the reroll helpers keep
// a group's seeds equal.

// Union-find over "two shaped nodes share a base-pose entity-space vertex". Returns
// seam-groups (singletons included). Quantized like applyCraftJitter's hash (1 mm),
// so it flags exactly the coincidences the shared-seed logic protects. Pre-jitter
// geometry — the coincidence a seed must preserve exists BEFORE the offset.
export function computeSeamGroups(doc: EntityDoc): string[][] {
  const owner = new Map<string, string>() // vertex key -> a node name that touches it
  const dsu = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (dsu.get(r) !== r) r = dsu.get(r)!
    while (dsu.get(x) !== r) {
      const n = dsu.get(x)!
      dsu.set(x, r)
      x = n
    }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a),
      rb = find(b)
    if (ra !== rb) dsu.set(ra, rb)
  }
  const v = new THREE.Vector3()
  // carries the same craft/sub rig-tree inheritance as bakeParts, so the pre-jitter
  // vertices tested here are EXACTLY the ones the bake will jitter.
  const walk = (name: string, node: NodeDef, parentMatrix: THREE.Matrix4, inhCraft?: number, inhSub?: number): void => {
    const matrix = composeNodeMatrix(node, node.rot ?? [0, 0, 0], parentMatrix)
    const craft = node.craft ?? inhCraft
    const sub = node.sub ?? inhSub
    if (node.shape && node.shape !== 'mesh') {
      dsu.set(name, name)
      const built = buildGeometry(node, craft, sub)
      let geo = built.geo
      if (!GENERATED_SHAPES.has(node.shape) && (sub ?? 0) > 0) {
        const coarse = geo
        geo = subdivideGeometry(geo, sub ?? 0)
        coarse.dispose()
      }
      const pos = geo.getAttribute('position') as THREE.BufferAttribute
      const seen = new Set<string>()
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(matrix)
        const k = `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)}`
        if (seen.has(k)) continue
        seen.add(k)
        const prev = owner.get(k)
        if (prev === undefined) owner.set(k, name)
        else union(prev, name)
      }
      geo.dispose()
    }
    for (const [cn, cd] of Object.entries(node.children ?? {})) walk(cn, cd, matrix, craft, sub)
  }
  for (const [name, node] of Object.entries(doc.rig ?? {})) walk(name, node, new THREE.Matrix4())
  const groups = new Map<string, string[]>()
  for (const name of dsu.keys()) {
    const r = find(name)
    ;(groups.get(r) ?? groups.set(r, []).get(r)!).push(name)
  }
  return [...groups.values()]
}

// Assign a craftSeed to every shaped node that lacks one (STUDIO/tool). First-ever
// seeding gives ONE shared value to all (coherent jitter, every seam trivially
// sealed); a node added later gets a fresh value. Mutates doc.rig; returns the full
// name→seed map so the caller can mirror it into the raw JSON.
export function ensureCraftSeeds(doc: EntityDoc): Record<string, number> {
  const shaped = shapedNodes(doc)
  const anySeeded = shaped.some(([, n]) => n.craftSeed !== undefined)
  const shared = randSeed()
  const map: Record<string, number> = {}
  for (const [name, node] of shaped) {
    if (node.craftSeed === undefined) node.craftSeed = anySeeded ? randSeed() : shared
    map[name] = node.craftSeed
  }
  return map
}

// Reroll ALL parts to one fresh shared value (coherent re-crook, seams sealed).
export function rerollCraftSeeds(doc: EntityDoc): Record<string, number> {
  const shared = randSeed()
  const map: Record<string, number> = {}
  for (const [name, node] of shapedNodes(doc)) {
    node.craftSeed = shared
    map[name] = shared
  }
  return map
}

// Reroll ONE part — and, so a real seam can't crack, its whole seam-group — to a
// fresh value. Singletons (the 40/44 props with no welded corners) reroll alone.
export function rerollPartSeed(doc: EntityDoc, nodeNames: string[]): Record<string, number> {
  const groups = computeSeamGroups(doc)
  const affected = new Set<string>()
  for (const target of nodeNames) {
    const g = groups.find((grp) => grp.includes(target))
    for (const n of g ?? [target]) affected.add(n)
  }
  const fresh = randSeed()
  const map: Record<string, number> = {}
  for (const [name, node] of shapedNodes(doc)) {
    if (affected.has(name)) node.craftSeed = fresh
    map[name] = node.craftSeed ?? fresh
  }
  return map
}

// Build a live THREE tree from a doc + ONE baked variant — the runtime path
// (studio preview + game). No generation, no rng: which nodes exist, their
// rotJitter and their geometry all come from `baked`.
//
// SKELETAL path (doc.skinned — phase 1, rigid weights): every node's `outer` becomes a
// THREE.Bone (a plain Object3D, so the anim player drives it unchanged), and instead of
// parenting rigid meshes each node's geometry is baked to ENTITY space at bind pose,
// tagged 100% to its node's bone (skinIndex/weight 1), and wrapped in SkinnedMeshes at
// the group root. Visuals are identical to the rigid build; the skeleton is the door to
// phase-2 smooth joints (see docs/SKELETAL_ANIMATION_RESEARCH.md).
export function buildEntity(doc: EntityDoc, baked: BakedVariant): BuiltEntity {
  const skinned = doc.skinned === true
  const group = new THREE.Group()
  group.name = doc.id
  const nodes = new Map<string, BuiltNode>()
  const meshes: THREE.Mesh[] = []
  const bones: THREE.Bone[] = []
  interface SkinPart {
    geo: THREE.BufferGeometry
    mat: THREE.Material | THREE.Material[]
    slotByIndex: string[]
    boneIdx: number
    nodeName: string
  }
  const skinParts: SkinPart[] = []

  // item 34: resolve slot inheritance ONCE — every downstream lookup reads it.
  const resolvedMaterials = resolveMaterials(doc.materials)
  const slotMaterials = new Map<string, EntityMaterial>()
  for (const [slot, def] of Object.entries(resolvedMaterials)) slotMaterials.set(slot, makeSlotMaterial(slot, def))

  // Walk the baked SCENE TREE — every field (transform, shape, material slot,
  // hidden, children) comes from the baked node; the rig is never consulted.
  const buildNode = (name: string, b: BakedNode, parent: THREE.Object3D, parentMatrix: THREE.Matrix4): void => {
    const pivot = b.pivot ?? [0, 0, 0]
    const pos = b.pos
    const outer = skinned ? new THREE.Bone() : new THREE.Group()
    outer.name = name
    outer.position.set(pos[0] + pivot[0], pos[1] + pivot[1], pos[2] + pivot[2])
    const rot = b.rot
    outer.rotation.set(
      THREE.MathUtils.degToRad(rot[0]),
      THREE.MathUtils.degToRad(rot[1]),
      THREE.MathUtils.degToRad(rot[2]),
    )
    if (b.scale !== undefined) {
      if (typeof b.scale === 'number') outer.scale.setScalar(b.scale)
      else outer.scale.set(b.scale[0], b.scale[1], b.scale[2])
    }

    const inner = new THREE.Group()
    inner.position.set(-pivot[0], -pivot[1], -pivot[2])
    outer.add(inner)
    outer.updateMatrix()
    inner.updateMatrix()
    const nodeMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, outer.matrix).multiply(inner.matrix)

    const boneIdx = bones.length
    if (skinned) bones.push(outer as THREE.Bone)

    if (b.shape && b.geom) {
      for (const m of loadNodeMeshes(name, b, b.geom, slotMaterials, resolvedMaterials, nodeMatrix)) {
        if (skinned) {
          // bake the node-local geometry to ENTITY space (= bind pose) and remember its
          // bone — the SkinnedMesh assembly below tags + binds it after the walk.
          m.geometry.applyMatrix4(nodeMatrix)
          skinParts.push({
            geo: m.geometry,
            mat: m.material,
            slotByIndex: (m.userData.slotByIndex as string[]) ?? [],
            boneIdx,
            nodeName: name,
          })
        } else {
          inner.add(m)
          meshes.push(m)
        }
      }
    }

    const defaultVisible = b.hidden !== true
    outer.visible = defaultVisible
    nodes.set(name, {
      outer,
      inner,
      base: { pos: outer.position.clone(), rot: outer.rotation.clone(), scale: outer.scale.clone() },
      defaultVisible,
    })
    parent.add(outer)
    for (const [cn, cc] of Object.entries(b.children ?? {})) buildNode(cn, cc, inner, nodeMatrix)
  }

  const identity = new THREE.Matrix4()
  for (const [name, b] of Object.entries(baked.nodes)) buildNode(name, b, group, identity)

  if (skinned && skinParts.length) {
    // Bind pose = the freshly-built hierarchy: compute bone worlds (group as root),
    // then one SkinnedMesh per part, every vertex weighted 100% to the part's bone.
    // Per-part meshes keep this dead simple (a character is ~10 parts = ~10 draws);
    // phase 2 would merge parts and blend weights across joint bones instead.
    group.updateMatrixWorld(true)
    const skeleton = new THREE.Skeleton(bones)
    for (const part of skinParts) {
      const count = part.geo.getAttribute('position').count
      const idx = new Uint16Array(count * 4)
      const wgt = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        idx[i * 4] = part.boneIdx
        wgt[i * 4] = 1
      }
      part.geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
      part.geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4))
      const sm = new THREE.SkinnedMesh(part.geo, part.mat)
      sm.name = part.nodeName
      sm.userData.nodeName = part.nodeName
      sm.userData.slotByIndex = part.slotByIndex
      sm.castShadow = true
      sm.receiveShadow = true
      sm.frustumCulled = false // the bind-pose bounds lie once bones move the verts
      group.add(sm)
      sm.bind(skeleton) // bindMatrix = identity in group space; inverses from the bone worlds above
      meshes.push(sm as unknown as THREE.Mesh)
    }
  }

  const bounds = new THREE.Box3().setFromObject(group)
  return { group, nodes, meshes, slotMaterials, bounds, seed: 0, tintK: 1 }
}

// IMPORTED-GLB path — parallel to buildEntity. No procgeom, no baked variant, no CSG,
// no merge: the GLB's native meshes / skeleton / PBR materials / clips are used verbatim
// (the model ships its own textures — nothing is retextured). Produces the same
// BuiltEntity contract the editor + preview consume, plus mixer/clips for animation.
export function buildGlbEntity(doc: EntityDoc, model: GltfModel): BuiltEntity {
  const group = new THREE.Group()
  group.name = doc.id
  group.add(model.scene)

  // doc-authored uniform size — applied before the bounds below so camera-fit sees the real
  // footprint. Same field the game applies at its own build site (inventory-entity.ts).
  if (doc.model) model.scene.scale.setScalar(doc.model.scale)

  const nodes = new Map<string, BuiltNode>()
  const meshes: THREE.Mesh[] = []
  const emissiveParts = new Map<string, THREE.MeshStandardMaterial>()
  for (const mesh of model.meshes) {
    // the part's PUBLIC name is the tag-stripped mesh name — "crystals@exposeEmissive"
    // is addressed as "crystals" everywhere doc-side (emissive, dismember, show/hide);
    // the raw tagged name lives only inside the GLB.
    const exposed = exposedEmissiveName(mesh.name || 'mesh')
    const name = exposed ?? (mesh.name || 'mesh')
    mesh.userData.nodeName = name
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false // bind-pose bounds lie once bones move the verts

    // "@exposeEmissive"-tagged part → give it its OWN material (the GLB shares one atlas
    // material across parts) so only this part glows, and apply the authored colour/intensity.
    if (exposed) {
      const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
      const mat = src.clone() // shares the atlas texture; independent emissive
      const cfg = doc.model?.emissive?.[exposed]
      mat.emissive = new THREE.Color(cfg?.color ?? '#ffffff')
      mat.emissiveIntensity = cfg?.intensity ?? 1.5
      mat.userData.exposedEmissive = true // its emissive channel IS the glow — the global ambient-lift graft must skip it
      mesh.material = mat
      emissiveParts.set(exposed, mat)
    }

    meshes.push(mesh)
    // nodes are VISIBILITY-ONLY (show/hide + picking). AnimationsDriver drives the BONES via
    // the mixer — a different set of objects — never these.
    nodes.set(name, {
      outer: mesh as unknown as THREE.Group,
      inner: new THREE.Group(), // unused (no merge) — satisfies the BuiltNode contract
      base: { pos: mesh.position.clone(), rot: mesh.rotation.clone(), scale: mesh.scale.clone() },
      defaultVisible: true,
    })
  }

  const bounds = new THREE.Box3().setFromObject(group)
  const mixer = new THREE.AnimationMixer(group)
  return {
    group,
    nodes,
    meshes,
    slotMaterials: new Map(),
    bounds,
    seed: 0,
    tintK: 1,
    mixer,
    clips: model.clips,
    emissiveParts,
  }
}

export function disposeEntity(built: BuiltEntity): void {
  built.group.removeFromParent()
  built.group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose()
  })
  // slot materials are SHARED via the materials.ts cache (one instance per resolved
  // def across all entities) — never disposed per entity. The cache owns them for
  // the session; setMaterialCatalog turns the generation over.
}

// Wireframe visualization of the physics collider.
export function buildColliderViz(doc: EntityDoc, bounds: THREE.Box3): THREE.Object3D | null {
  const phys = doc.physics
  if (!phys) return null
  const mat = new THREE.LineBasicMaterial({ color: 0x00ff88 })
  const col = phys.collider ?? 'auto'
  if (col === 'auto') {
    const helper = new THREE.Box3Helper(bounds.clone(), 0x00ff88)
    return helper
  }
  let geo: THREE.BufferGeometry
  const off = col.offset ?? [0, 0, 0]
  if (col.shape === 'box') geo = new THREE.BoxGeometry(...(col.size ?? [1, 1, 1]))
  else if (col.shape === 'sphere') geo = new THREE.SphereGeometry(col.radius ?? 0.5, 12, 8)
  else if (col.shape === 'capsule') geo = new THREE.CapsuleGeometry(col.radius ?? 0.5, col.height ?? 1, 4, 8)
  else geo = new THREE.CylinderGeometry(col.radius ?? 0.5, col.radius ?? 0.5, col.height ?? 1, 12)
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geo), mat)
  wire.position.set(...(off as [number, number, number]))
  geo.dispose()
  return wire
}
