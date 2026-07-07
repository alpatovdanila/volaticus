// Builds a live THREE object tree from an entity doc. Used identically by the
// editor preview and (later) the game — what the editor shows is what ships.
import * as THREE from 'three'
import { mulberry32, randRange } from '../lib/rng'
import { catalogDefaultUvProject, catalogDefaultUvScale, makeSlotMaterial, type EntityMaterial } from './materials'
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
import { resolveMaterials, type EntityDoc, type FaceKey, type NodeDef, type ResolvedMaterialDef } from './schema'

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
// Positions are hashed in ENTITY space (the node's composed transform chain),
// with the shared entity/variant seed — so coincident vertices of DIFFERENT
// nodes (e.g. two shell halves meeting at a barrel's waist) receive the same
// offset and the seam stays sealed. An explicit node.seed (per-part ⟲ regen)
// mixes in and accepts local divergence.
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
  // variants.tintJitter multiplier baked into every slot material's color
  // (1 = no jitter). Exposed so vegetation batching can divide it back out and
  // re-apply it per-instance (BatchedMesh setColorAt) — one shared material.
  tintK: number
}

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

// group index -> face key mapping for the shapes that carry geometry groups
function groupFacesOf(node: NodeDef): readonly FaceKey[] {
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

// node.uvProject: re-project UVs in ENTITY space, after build/subdivide/jitter.
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
  node: NodeDef,
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

// The UV projection to use for a node. Resolution order (most specific wins):
//   1. node.uvProject (authored per-node)
//   2. the slot material's per-slot uvProject override (#4 per-part)
//   3. the catalog material's DEFAULT uvProject (tuning.uvProject, #13)
// undefined = keep authored/tiled UVs. Never for meshes (authored atlas UVs).
function effectiveUvProject(
  node: NodeDef,
  materials: Record<string, ResolvedMaterialDef>,
): 'box' | 'planar' | 'sphere' | undefined {
  if (node.shape === 'mesh') return undefined
  const slots = !node.material
    ? []
    : typeof node.material === 'string'
      ? [node.material]
      : Object.values(node.material)
  // PRECEDENCE (highest first): the per-slot chip override is AUTHORITATIVE — an
  // explicit editor choice outranks the authored node-level uvProject, so the UI
  // dropdown always changes the model (previously node-level won and the chip was
  // inert/locked on most props). 'none' is the EXPLICIT "authored/tiled UVs, no
  // projection" override — it resolves like any other value and blocks both the
  // node default and the catalog fallback below.
  for (const slot of slots) {
    if (!slot) continue
    const p = materials[slot]?.uvProject
    if (p) return p === 'none' ? undefined : p
  }
  // then the authored node-level projection (the asset's baked-in default)
  if (node.uvProject !== undefined) return node.uvProject
  if (!slots.length) return undefined
  // then the material's own default projection from its catalog tuning
  for (const slot of slots) {
    if (!slot) continue
    const id = materials[slot]?.material
    const p = id ? catalogDefaultUvProject(id) : undefined
    if (p) return p
  }
  return undefined
}

// #32 ROOT CAUSE (rewritten): this used to early-return for the generated lumber
// shapes (plank/post/arrow/star), so their slots' uvMode/uvScale changes were
// simply never applied — the "tiling sometimes doesn't apply" bug (crates,
// benches, fences, wells are almost all planks/posts). Their UVs are authored in
// METERS (faces carry su=sv=1), while built-in shapes author 0..1 per face with
// the world size in faces[gi].su/sv — so: (1) scale every group's UVs to meters,
// (2) meter by uvMode + effective uvScale (slot × material default) with the
// same meterGroupUVs the projection path uses, (3) bake the slot's uvRot. Only
// shape "mesh" keeps its authored atlas UVs unmetered (uvRot still bakes).
function applyUvTiling(
  geo: THREE.BufferGeometry,
  faces: FaceRepeat[],
  node: NodeDef,
  materials: Record<string, ResolvedMaterialDef>,
): void {
  // shape "mesh" keeps its authored atlas UVs — never retiled/metered — but the
  // uvRot bake still applies (it replaces the texture-space rotation the material
  // used to carry via per-slot texture clones, for every shape alike).
  const retile = node.shape !== 'mesh'
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  if (!uv) return
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: indexCount(geo), materialIndex: 0 }]
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const f = faces[gi] ?? faces[0]
    if (!f) continue
    const def = materials[resolveFaceSlot(node.material, f.face)]
    if (!def) continue
    if (!retile && !def.uvRot) continue
    const count = g.count === Infinity ? indexCount(geo) - g.start : g.count
    const verts = groupVerts(geo, g.start, count)
    if (retile) {
      // 1) authored 0..1 → meters via the face's world size (su=sv=1 = already meters)
      if (f.su !== 1 || f.sv !== 1)
        for (const vi of verts) uv.setXY(vi, uv.getX(vi) * f.su, uv.getY(vi) * f.sv)
      // 2) tile / fit / stretch metering at the effective density
      meterGroupUVs(uv, verts, def.uvMode ?? 'tile', effectiveUvScale(def))
    }
    // 3) baked texture direction (see rotateGroupUVs) — after metering, like the
    // shader applied texture.rotation to the final metered UVs
    rotateGroupUVs(uv, verts, def.uvRot)
  }
  uv.needsUpdate = true
}

function makeMesh(
  nodeName: string,
  node: NodeDef,
  slotMaterials: Map<string, EntityMaterial>,
  materials: Record<string, ResolvedMaterialDef>,
  jitterSeed: number,
  nodeMatrix: THREE.Matrix4,
): THREE.Mesh[] {
  const built = buildGeometry(node)
  let geo = built.geo
  // uvProject replaces the shape's authored/tiled UVs wholesale (after jitter).
  // Node-level uvProject wins; else the slot material's per-slot uvProject (#4).
  const projectMode = effectiveUvProject(node, materials)
  const project = projectMode !== undefined
  if (!project) applyUvTiling(geo, built.faces, node, materials)
  const generated = GENERATED_SHAPES.has(node.shape)
  if (!generated && node.shape !== 'mesh') {
    const sub = node.sub ?? 0
    if (sub > 0) {
      const coarse = geo
      geo = subdivideGeometry(geo, sub)
      coarse.dispose()
    }
  }
  // one unified craft pass for every shape (generated lumber defaults to 0.5):
  // entity-space positional hash, so seams between abutting nodes stay sealed
  const craft = node.craft ?? (generated ? 0.5 : undefined)
  if (craft !== undefined && node.shape !== 'mesh') applyCraftJitter(geo, craft, nodeMatrix, jitterSeed)
  if (project) geo = applyUvProjection(geo, node, materials, nodeMatrix, projectMode)

  // aoMap samples uv2. Catalog materials all carry an AO map, so every geometry
  // needs a uv2 — share the (final, metered) uv channel. Cheap: same buffer.
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

export function buildEntity(doc: EntityDoc, seed = 1): BuiltEntity {
  const rng = mulberry32(seed)
  const group = new THREE.Group()
  group.name = doc.id
  const nodes = new Map<string, BuiltNode>()
  const meshes: THREE.Mesh[] = []

  // structural variants: keep exactly one node per oneOf group, drop the rest
  const dropped = new Set<string>()
  for (const names of Object.values(doc.variants?.oneOf ?? {})) {
    const keep = names[Math.floor(rng() * names.length) % names.length]
    for (const n of names) if (n !== keep) dropped.add(n)
  }

  // item 34: resolve slot inheritance ONCE — every downstream lookup (material
  // construction, UV metering, projection) reads fully-resolved defs.
  const resolvedMaterials = resolveMaterials(doc.materials)
  const slotMaterials = new Map<string, EntityMaterial>()
  for (const [slot, def] of Object.entries(resolvedMaterials)) slotMaterials.set(slot, makeSlotMaterial(slot, def))

  const buildNode = (name: string, node: NodeDef, parent: THREE.Object3D, parentMatrix: THREE.Matrix4): void => {
    if (dropped.has(name)) return
    if (node.chance !== undefined && rng() > node.chance) return

    const pivot = node.pivot ?? [0, 0, 0]
    const pos = node.pos ?? [0, 0, 0]
    const outer = new THREE.Group()
    outer.name = name
    outer.position.set(pos[0] + pivot[0], pos[1] + pivot[1], pos[2] + pivot[2])
    const rot = [...(node.rot ?? [0, 0, 0])]
    if (node.rotJitter) for (let i = 0; i < 3; i++) rot[i] += randRange(rng, -node.rotJitter[i], node.rotJitter[i])
    outer.rotation.set(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]))
    if (node.scale !== undefined) {
      if (typeof node.scale === 'number') outer.scale.setScalar(node.scale)
      else outer.scale.set(...node.scale)
    }

    const inner = new THREE.Group()
    inner.position.set(-pivot[0], -pivot[1], -pivot[2])
    outer.add(inner)

    // entity-space transform of this node's geometry — the craft jitter hashes
    // positions through it so abutting nodes stay sealed
    outer.updateMatrix()
    inner.updateMatrix()
    const nodeMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, outer.matrix).multiply(inner.matrix)

    // deterministic jitter seed: the shared variant seed, mixed with node.seed
    // ONLY when explicitly set (written by the editor's per-part ⟲ regen —
    // accepting local divergence). Same inputs → identical geometry, every
    // build, editor and game alike.
    if (node.shape) {
      const jitterSeed = node.seed !== undefined ? (seed ^ (node.seed | 0)) | 0 : seed
      for (const m of makeMesh(name, node, slotMaterials, resolvedMaterials, jitterSeed, nodeMatrix)) {
        inner.add(m)
        meshes.push(m)
      }
    }

    const defaultVisible = node.hidden !== true
    outer.visible = defaultVisible
    nodes.set(name, {
      outer,
      inner,
      base: { pos: outer.position.clone(), rot: outer.rotation.clone(), scale: outer.scale.clone() },
      defaultVisible,
    })
    parent.add(outer)
    for (const [cn, cd] of Object.entries(node.children ?? {})) buildNode(cn, cd, inner, nodeMatrix)
  }

  const identity = new THREE.Matrix4()
  for (const [name, node] of Object.entries(doc.rig)) buildNode(name, node, group, identity)

  // seeded per-instance variation
  const v = doc.variants
  if (v?.scale) group.scale.setScalar(randRange(rng, v.scale[0], v.scale[1]))
  if (v?.yawJitter) group.rotation.y = THREE.MathUtils.degToRad(randRange(rng, -v.yawJitter, v.yawJitter))
  if (v?.tiltJitter) {
    group.rotation.x = THREE.MathUtils.degToRad(randRange(rng, -v.tiltJitter, v.tiltJitter))
    group.rotation.z = THREE.MathUtils.degToRad(randRange(rng, -v.tiltJitter, v.tiltJitter))
  }
  let tintK = 1
  if (v?.tintJitter) {
    tintK = 1 + randRange(rng, -v.tintJitter, v.tintJitter)
    for (const mat of slotMaterials.values()) mat.color.multiplyScalar(tintK)
  }

  const bounds = new THREE.Box3().setFromObject(group)
  return { group, nodes, meshes, slotMaterials, bounds, seed, tintK }
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
