// Builds a live THREE object tree from an entity doc. Used identically by the
// editor preview and (later) the game — what the editor shows is what ships.
import * as THREE from 'three'
import { randRange } from '../lib/rng'
import { catalogDefaultUvScale, makeSlotMaterial, type EntityMaterial } from './materials'
import { getMeshGeometry } from './meshes'
import {
  craftAmount,
  generateArrowPlank,
  generateDisk,
  generatePlank,
  generatePost,
  generateRing,
  generateStar,
  generateTube,
  hash3,
  subdivideTriangleSoup,
  type GeneratedGeometry,
} from './procgeom'
import { resolveMaterials, walkRig, type EntityDoc, type FaceKey, type NodeDef, type ResolvedMaterialDef } from './schema'

// generated shapes: always jittered (craft defaults to 0.5), authored UVs
const GENERATED_SHAPES = new Set<NodeDef['shape']>(['plank', 'post', 'ring', 'arrow', 'star'])

function toBufferGeometry(g: GeneratedGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2))
  geo.setIndex(g.indices)
  for (const grp of g.groups ?? []) geo.addGroup(grp.start, grp.count, grp.materialIndex)
  geo.computeVertexNormals()
  return geo
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
  geo.computeVertexNormals()
}

// Midpoint-subdivide any geometry (group-aware, output non-indexed). Runs
// before craft jitter so abstract shapes get enough vertices to deform.
function subdivideGeometry(geo: THREE.BufferGeometry, levels: number): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo
  const pos = Array.from((src.getAttribute('position') as THREE.BufferAttribute).array as Float32Array)
  const uv = Array.from((src.getAttribute('uv') as THREE.BufferAttribute).array as Float32Array)
  const vertCount = pos.length / 3
  const groups = src.groups.length ? src.groups : geo.groups.length ? geo.groups : [{ start: 0, count: vertCount, materialIndex: 0 }]

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
    outPos.push(...sub.positions)
    outUv.push(...sub.uvs)
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
  out.computeVertexNormals()
  if (src !== geo) src.dispose()
  return out
}

export interface BuiltNode {
  outer: THREE.Group // animation target, origin at the node's pivot point
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
  shape?: NodeDef['shape'] // drives per-face material mapping + cross/mesh handling at load
  material?: NodeDef['material'] // slot name(s) — resolved against the main file's `materials` (which also carry uvProject)
  geom?: BakedNodeGeom // absent on pure-group (shapeless) nodes
  children?: Record<string, BakedNode> // nested subtree (the rig hierarchy, baked in)
}
export interface BakedVariant {
  nodes: Record<string, BakedNode> // ROOT nodes; the tree nests via BakedNode.children
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

// Meter one group's uv coords — the UVs must already be in METERS (1 uv unit =
// 1 world meter). tile = uvScale repeats per meter; fit = whole repeats over the
// group's uv extent (patterns never cut mid-motif); stretch = exactly once.
// Shared by the tiling path AND the uv-projection path so every mode composes
// with every projection (#32: projection used to be suspected of dropping this).
function meterGroupUVs(uv: THREE.BufferAttribute, verts: Set<number>, uvMode: string, scale: number): void {
  if (uvMode === 'tile') {
    if (scale !== 1) for (const vi of verts) uv.setXY(vi, uv.getX(vi) * scale, uv.getY(vi) * scale)
    return
  }
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (const vi of verts) {
    const uu = uv.getX(vi), vv = uv.getY(vi)
    if (uu < minU) minU = uu
    if (uu > maxU) maxU = uu
    if (vv < minV) minV = vv
    if (vv > maxV) maxV = vv
  }
  const eu = Math.max(maxU - minU, 1e-6)
  const ev = Math.max(maxV - minV, 1e-6)
  // fit: whole repeats over the extent; stretch: exactly once
  const ru = uvMode === 'fit' ? Math.max(1, Math.round(eu * scale)) : 1
  const rv = uvMode === 'fit' ? Math.max(1, Math.round(ev * scale)) : 1
  for (const vi of verts) uv.setXY(vi, ((uv.getX(vi) - minU) / eu) * ru, ((uv.getY(vi) - minV) / ev) * rv)
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
// metal/alpha/emissive) plus uv2 (same buffer) — land on identical texels.
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

function buildGeometry(node: NodeDef): { geo: THREE.BufferGeometry; faces: FaceRepeat[] } {
  // deforming nodes get aspect-corrected sources so triangles stay ~uniform
  const deforms = node.craft !== undefined || (node.sub ?? 0) > 0
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
      // extruded n-point star in the XY plane (a point straight up)
      const r = node.radius!
      const geo = toBufferGeometry(
        generateStar(r, node.innerRatio ?? 0.45, node.points ?? 5, node.depth ?? r * 0.35, 1, 0),
      )
      return { geo, faces: [{ face: 'all', su: 1, sv: 1 }] }
    }
    case 'post': {
      const rt = node.radiusTop ?? node.radius!
      const rb = node.radiusBottom ?? node.radius!
      const geo = toBufferGeometry(generatePost(rt, rb, node.height!, node.segments ?? 14, 1, 0))
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
      const geo = toBufferGeometry(generateRing(rt, rb, h, node.thickness!, node.segments ?? 16, 1, 0))
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
      const geo = toBufferGeometry(generateTube(rt, rb, h, node.segments ?? 20, { open: node.open ?? false, bulge: node.bulge }))
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
      const r = node.radius!, h = node.height!
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
      const r = node.radius!, t = node.tube!
      // tube segments from the tube/ring circumference ratio — uniform quads
      const ringSegs = node.segments ?? 24
      const tubeSegs = Math.max(6, Math.min(12, Math.round((2 * Math.PI * t) / ((2 * Math.PI * r) / ringSegs))))
      const geo = new THREE.TorusGeometry(r, t, tubeSegs, ringSegs)
      geo.rotateX(Math.PI / 2) // lie flat, ring axis = Y (crown/rim orientation)
      return { geo, faces: [{ face: 'all', su: 2 * Math.PI * r, sv: 2 * Math.PI * t }] }
    }
    case 'capsule': {
      const r = node.radius!, h = node.height!
      const geo = new THREE.CapsuleGeometry(r, h, 6, 16)
      return { geo, faces: [{ face: 'all', su: 2 * Math.PI * r, sv: h + Math.PI * r }] }
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
type RenderNode = Pick<NodeDef, 'shape' | 'material'>

// group index -> face key mapping for the shapes that carry geometry groups
function groupFacesOf(node: RenderNode): readonly FaceKey[] {
  switch (node.shape) {
    case 'box':
      return BOX_GROUP_FACES
    case 'cylinder':
    case 'post':
    case 'ring':
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
    // box: per triangle, project along the dominant axis of its normal
    for (let t = 0; t + 2 < n; t += 3) {
      const ax = pts[t * 3], ay = pts[t * 3 + 1], az = pts[t * 3 + 2]
      const e1x = pts[(t + 1) * 3] - ax, e1y = pts[(t + 1) * 3 + 1] - ay, e1z = pts[(t + 1) * 3 + 2] - az
      const e2x = pts[(t + 2) * 3] - ax, e2y = pts[(t + 2) * 3 + 1] - ay, e2z = pts[(t + 2) * 3 + 2] - az
      const nx = Math.abs(e1y * e2z - e1z * e2y)
      const ny = Math.abs(e1z * e2x - e1x * e2z)
      const nz = Math.abs(e1x * e2y - e1y * e2x)
      const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2
      for (let k = 0; k < 3; k++) {
        const i = t + k
        const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2]
        if (axis === 0) uv.setXY(i, z, y)
        else if (axis === 1) uv.setXY(i, x, -z)
        else uv.setXY(i, x, y)
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
    meterGroupUVs(uv, verts, def.uvMode ?? 'tile', effectiveUvScale(def))
    rotateGroupUVs(uv, verts, def.uvRot) // baked texture direction (see rotateGroupUVs)
  }
  uv.needsUpdate = true
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
  const slots = !node.material
    ? []
    : typeof node.material === 'string'
      ? [node.material]
      : Object.values(node.material)
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
function meterBakedUvs(geo: THREE.BufferGeometry, node: RenderNode, materials: Record<string, ResolvedMaterialDef>): void {
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
    if (retile) meterGroupUVs(uv, verts, def.uvMode ?? 'tile', effectiveUvScale(def)) // UVs already in meters
    rotateGroupUVs(uv, verts, def.uvRot)
  }
  uv.needsUpdate = true
}

// serialize a built geometry into the stored form / rebuild it back.
function extractGeom(geo: THREE.BufferGeometry): BakedNodeGeom {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  const idx = geo.getIndex()
  const vertCount = idx ? idx.count : pos.count
  return {
    positions: Array.from(pos.array as Float32Array),
    normals: nrm ? Array.from(nrm.array as Float32Array) : [],
    uv: uv ? Array.from(uv.array as Float32Array) : [],
    index: idx ? Array.from(idx.array as ArrayLike<number>) : [],
    groups: (geo.groups.length ? geo.groups : [{ start: 0, count: vertCount, materialIndex: 0 }]).map((g) => [
      g.start,
      g.count === Infinity ? vertCount - g.start : g.count,
      g.materialIndex ?? 0,
    ]),
  }
}
function bakedGeomToBuffer(b: BakedNodeGeom): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3))
  if (b.normals.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3))
  if (b.uv.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2)) // a UV-less mesh keeps none (matches the old path)
  if (b.index.length) geo.setIndex(b.index)
  for (const [start, count, mi] of b.groups) geo.addGroup(start, count, mi)
  if (!b.normals.length) geo.computeVertexNormals()
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
  outer.rotation.set(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]))
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

// BAKE one node's geometry (STUDIO/tool only): generate → subdivide → craft
// jitter (entity-space, seeded per variant) → UVs-to-meters → serialize. Returns
// null for a mesh whose FBX isn't preloaded.
function bakeNodeGeometry(node: NodeDef, matrix: THREE.Matrix4, jitterSeed: number): BakedNodeGeom | null {
  if (node.shape === 'mesh') {
    const g = getMeshGeometry(node.mesh!)
    return g ? extractGeom(g.clone()) : null
  }
  const built = buildGeometry(node)
  let geo = built.geo
  const generated = GENERATED_SHAPES.has(node.shape)
  if (!generated) {
    const sub = node.sub ?? 0
    if (sub > 0) {
      const coarse = geo
      geo = subdivideGeometry(geo, sub)
      coarse.dispose()
    }
  }
  const craft = node.craft ?? (generated ? 0.5 : undefined)
  if (craft !== undefined) applyCraftJitter(geo, craft, matrix, jitterSeed)
  bakeUvsToMeters(geo, built.faces, node)
  return extractGeom(geo)
}

// LOAD one node's render meshes from its BAKED geometry (runtime + studio): the
// cheap live steps only — UV metering/projection + uvRot (so material edits show
// without a re-bake), uv2, and per-face material assignment. "cross" → two meshes.
function loadNodeMeshes(
  nodeName: string,
  node: RenderNode,
  bakedGeom: BakedNodeGeom,
  slotMaterials: Map<string, EntityMaterial>,
  materials: Record<string, ResolvedMaterialDef>,
  nodeMatrix: THREE.Matrix4,
): THREE.Mesh[] {
  let geo = bakedGeomToBuffer(bakedGeom)
  const projectMode = effectiveUvProject(node, materials)
  if (projectMode !== undefined) geo = applyUvProjection(geo, node, materials, nodeMatrix, projectMode)
  else meterBakedUvs(geo, node, materials)

  const uv = geo.getAttribute('uv')
  if (uv && !geo.getAttribute('uv2')) geo.setAttribute('uv2', uv)

  const slotFor = (face: FaceKey) => slotMaterials.get(resolveFaceSlot(node.material, face))!
  let material: THREE.Material | THREE.Material[]
  let slotByIndex: string[]
  if (node.shape === 'box') {
    material = BOX_GROUP_FACES.map((f) => slotFor(f))
    slotByIndex = BOX_GROUP_FACES.map((f) => resolveFaceSlot(node.material, f))
  } else if (node.shape === 'cylinder' || node.shape === 'post' || node.shape === 'ring') {
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
  walkRig(doc.rig, (name, node) => {
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
  for (const [name, node] of Object.entries(doc.rig)) walk(name, node)
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
function bakeParts(doc: EntityDoc): Record<string, BakedNodeGeom> {
  const parts: Record<string, BakedNodeGeom> = {}
  const walk = (name: string, node: NodeDef, parentMatrix: THREE.Matrix4): void => {
    const matrix = composeNodeMatrix(node, node.rot ?? [0, 0, 0], parentMatrix)
    if (node.shape) {
      const g = bakeNodeGeometry(node, matrix, node.craftSeed ?? 0)
      if (g) parts[name] = g
    }
    for (const [cn, cd] of Object.entries(node.children ?? {})) walk(cn, cd, matrix)
  }
  const identity = new THREE.Matrix4()
  for (const [name, node] of Object.entries(doc.rig)) walk(name, node, identity)
  return parts
}

// Compose one variant into a self-contained scene tree by READING the resolved
// layout: for each part the layout lists, emit a baked node carrying the rig's
// render fields + the layout's final pos/rot + the once-baked geometry, and nest
// its surviving children. A node absent from layout.parts is dropped with its whole
// subtree. The result needs nothing from the rig at runtime.
function composeVariant(doc: EntityDoc, parts: Record<string, BakedNodeGeom>, layout: VariantLayout): BakedVariant {
  const build = (name: string, node: NodeDef): BakedNode | null => {
    const p = layout.parts[name]
    if (!p) return null // not in this variant (oneOf loser / chance drop)
    const entry: BakedNode = { pos: p.pos, rot: p.rot }
    if (node.scale !== undefined) entry.scale = node.scale
    if (node.pivot !== undefined) entry.pivot = node.pivot
    if (node.hidden) entry.hidden = true
    if (node.shape !== undefined) entry.shape = node.shape
    if (node.material !== undefined) entry.material = node.material
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
  for (const [name, node] of Object.entries(doc.rig)) {
    const b = build(name, node)
    if (b) nodes[name] = b
  }
  return { nodes }
}

// Compose the full baked geometry set (STUDIO/tool): parts baked once × the given
// layouts (or freshly rolled ones — the lineup path passes none). Deterministic in
// (craftSeeds, layouts): re-baking after a craft edit reproduces it exactly.
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
    const ra = find(a), rb = find(b)
    if (ra !== rb) dsu.set(ra, rb)
  }
  const v = new THREE.Vector3()
  const walk = (name: string, node: NodeDef, parentMatrix: THREE.Matrix4): void => {
    const matrix = composeNodeMatrix(node, node.rot ?? [0, 0, 0], parentMatrix)
    if (node.shape && node.shape !== 'mesh') {
      dsu.set(name, name)
      const built = buildGeometry(node)
      let geo = built.geo
      if (!GENERATED_SHAPES.has(node.shape) && (node.sub ?? 0) > 0) {
        const coarse = geo
        geo = subdivideGeometry(geo, node.sub ?? 0)
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
    for (const [cn, cd] of Object.entries(node.children ?? {})) walk(cn, cd, matrix)
  }
  for (const [name, node] of Object.entries(doc.rig)) walk(name, node, new THREE.Matrix4())
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
export function buildEntity(doc: EntityDoc, baked: BakedVariant): BuiltEntity {
  const group = new THREE.Group()
  group.name = doc.id
  const nodes = new Map<string, BuiltNode>()
  const meshes: THREE.Mesh[] = []

  // item 34: resolve slot inheritance ONCE — every downstream lookup reads it.
  const resolvedMaterials = resolveMaterials(doc.materials)
  const slotMaterials = new Map<string, EntityMaterial>()
  for (const [slot, def] of Object.entries(resolvedMaterials)) slotMaterials.set(slot, makeSlotMaterial(slot, def))

  // Walk the baked SCENE TREE — every field (transform, shape, material slot,
  // hidden, children) comes from the baked node; the rig is never consulted.
  const buildNode = (name: string, b: BakedNode, parent: THREE.Object3D, parentMatrix: THREE.Matrix4): void => {
    const pivot = b.pivot ?? [0, 0, 0]
    const pos = b.pos
    const outer = new THREE.Group()
    outer.name = name
    outer.position.set(pos[0] + pivot[0], pos[1] + pivot[1], pos[2] + pivot[2])
    const rot = b.rot
    outer.rotation.set(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]))
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

    if (b.shape && b.geom) {
      for (const m of loadNodeMeshes(name, b, b.geom, slotMaterials, resolvedMaterials, nodeMatrix)) {
        inner.add(m)
        meshes.push(m)
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

  const bounds = new THREE.Box3().setFromObject(group)
  return { group, nodes, meshes, slotMaterials, bounds, seed: 0, tintK: 1 }
}

export function disposeEntity(built: BuiltEntity): void {
  built.group.removeFromParent()
  built.group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose()
  })
  for (const m of built.slotMaterials.values()) m.dispose()
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
