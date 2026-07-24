// Baked per-vertex ambient occlusion — RETIRED from the bake pipeline (v5–v6):
// per-vertex resolution reads too shallow on low-poly primitives, and screen-space
// GTAO (Render panel) covers per-pixel occlusion incl. entity-vs-world. KEPT
// because the pieces here — the flat-array triangle BVH, the deterministic
// cosine-hemisphere sampler, the variant walker — are the seed of any future
// bake-time tracer (per-texel AO maps, a level lightmapper, shadow bakes).
//
// What it did: after a variant was composed, every vertex hemisphere-raycast the
// variant's own triangles + an assumed ground plane at y=0; the openness
// (1 = open, 0 = buried) was stored per vertex and loaded as a color attribute.
//
// Determinism: the hemisphere sample set is a fixed golden-spiral pattern (no
// rng), so identical inputs re-bake byte-identical results — same contract as
// craft jitter's seeded hashing.
import * as THREE from 'three'
import type { BakedNode, BakedNodeGeom, BakedVariant } from './factory'

// sidecar carrier for the baked values (v5–v6 files still hold this key)
type AoGeom = BakedNodeGeom & { ao?: number[] }

const SAMPLES = 32
// Occlusion horizon (m). Deliberately SHORT: per-vertex AO interpolates linearly
// across each triangle, and big flat faces (roof planks) have only corner verts —
// a long horizon lets far geometry darken one corner and paints the difference as
// a triangle-shaped gradient across the face. A tight horizon keeps the darkening
// at contacts/junctions, where bevels and caps give dense vertices.
const MAX_DIST = 0.55
const ORIGIN_EPS = 0.004 // lift ray origins off the surface (self-hit acne)

// cosine-weighted hemisphere directions (z-up local frame), golden spiral.
// Cosine weighting makes the plain average of visibility equal the AO integral.
const SAMPLE_DIRS = (() => {
  const dirs = new Float32Array(SAMPLES * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < SAMPLES; i++) {
    const u = (i + 0.5) / SAMPLES
    const r = Math.sqrt(u) // pdf ∝ cos(θ)
    const phi = i * golden
    dirs[i * 3] = r * Math.cos(phi)
    dirs[i * 3 + 1] = r * Math.sin(phi)
    dirs[i * 3 + 2] = Math.sqrt(1 - u)
  }
  return dirs
})()

// ---------------------------------------------------------------------------
// Flat-array BVH over a triangle soup (9 floats per tri, entity space). Median
// split on the longest centroid axis, closest-hit query with a t ceiling —
// small and cache-friendly; brute force would be O(verts × rays × tris).

interface TriBVH {
  bounds: Float32Array // 6 per node: minx miny minz maxx maxy maxz
  child: Int32Array // 2 per node: [left, right], or [-(start+1), count] for a leaf
  order: Uint32Array // tri indices, leaf ranges index into this
  tris: Float32Array
}

const LEAF_SIZE = 8

export function buildTriBVH(tris: Float32Array): TriBVH {
  const triCount = tris.length / 9
  const order = new Uint32Array(triCount)
  const centroids = new Float32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    order[t] = t
    const o = t * 9
    centroids[t * 3] = (tris[o] + tris[o + 3] + tris[o + 6]) / 3
    centroids[t * 3 + 1] = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3
    centroids[t * 3 + 2] = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3
  }
  const maxNodes = Math.max(1, triCount * 2)
  const bounds = new Float32Array(maxNodes * 6)
  const child = new Int32Array(maxNodes * 2)
  let nodeCount = 0

  const build = (start: number, count: number): number => {
    const node = nodeCount++
    const b = node * 6
    bounds[b] = bounds[b + 1] = bounds[b + 2] = Infinity
    bounds[b + 3] = bounds[b + 4] = bounds[b + 5] = -Infinity
    for (let i = start; i < start + count; i++) {
      const o = order[i] * 9
      for (let v = 0; v < 9; v += 3) {
        if (tris[o + v] < bounds[b]) bounds[b] = tris[o + v]
        if (tris[o + v + 1] < bounds[b + 1]) bounds[b + 1] = tris[o + v + 1]
        if (tris[o + v + 2] < bounds[b + 2]) bounds[b + 2] = tris[o + v + 2]
        if (tris[o + v] > bounds[b + 3]) bounds[b + 3] = tris[o + v]
        if (tris[o + v + 1] > bounds[b + 4]) bounds[b + 4] = tris[o + v + 1]
        if (tris[o + v + 2] > bounds[b + 5]) bounds[b + 5] = tris[o + v + 2]
      }
    }
    if (count <= LEAF_SIZE) {
      child[node * 2] = -(start + 1)
      child[node * 2 + 1] = count
      return node
    }
    // split on the longest centroid axis at the median
    const ex = bounds[b + 3] - bounds[b],
      ey = bounds[b + 4] - bounds[b + 1],
      ez = bounds[b + 5] - bounds[b + 2]
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
    const slice = Array.from(order.subarray(start, start + count))
    slice.sort((a, bb) => centroids[a * 3 + axis] - centroids[bb * 3 + axis])
    order.set(slice, start)
    const half = count >> 1
    const left = build(start, half)
    const right = build(start + half, count - half)
    child[node * 2] = left
    child[node * 2 + 1] = right
    return node
  }
  if (triCount > 0) build(0, triCount)
  return { bounds, child, order, tris }
}

// nearest triangle hit along (o, d) within tMax, or Infinity. Möller–Trumbore
// per leaf tri, slab test per node, nodes farther than the best hit pruned.
function closestHit(
  bvh: TriBVH,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMax: number,
): number {
  if (bvh.tris.length === 0) return Infinity
  const idx = 1 / dx,
    idy = 1 / dy,
    idz = 1 / dz
  let best = tMax
  const stack = [0]
  while (stack.length) {
    const node = stack.pop()!
    const b = node * 6
    // slab test
    let t0 = (bvh.bounds[b] - ox) * idx,
      t1 = (bvh.bounds[b + 3] - ox) * idx
    if (t0 > t1) {
      const tmp = t0
      t0 = t1
      t1 = tmp
    }
    let u0 = (bvh.bounds[b + 1] - oy) * idy,
      u1 = (bvh.bounds[b + 4] - oy) * idy
    if (u0 > u1) {
      const tmp = u0
      u0 = u1
      u1 = tmp
    }
    if (u0 > t0) t0 = u0
    if (u1 < t1) t1 = u1
    let v0 = (bvh.bounds[b + 2] - oz) * idz,
      v1 = (bvh.bounds[b + 5] - oz) * idz
    if (v0 > v1) {
      const tmp = v0
      v0 = v1
      v1 = tmp
    }
    if (v0 > t0) t0 = v0
    if (v1 < t1) t1 = v1
    if (t0 > t1 || t0 > best || t1 < 0) continue

    const c0 = bvh.child[node * 2]
    if (c0 < 0) {
      // leaf: Möller–Trumbore over its tris
      const start = -c0 - 1
      const count = bvh.child[node * 2 + 1]
      for (let i = start; i < start + count; i++) {
        const o = bvh.order[i] * 9
        const ax = bvh.tris[o],
          ay = bvh.tris[o + 1],
          az = bvh.tris[o + 2]
        const e1x = bvh.tris[o + 3] - ax,
          e1y = bvh.tris[o + 4] - ay,
          e1z = bvh.tris[o + 5] - az
        const e2x = bvh.tris[o + 6] - ax,
          e2y = bvh.tris[o + 7] - ay,
          e2z = bvh.tris[o + 8] - az
        const px = dy * e2z - dz * e2y,
          py = dz * e2x - dx * e2z,
          pz = dx * e2y - dy * e2x
        const det = e1x * px + e1y * py + e1z * pz
        if (det > -1e-9 && det < 1e-9) continue // parallel (both faces occlude)
        const inv = 1 / det
        const sx = ox - ax,
          sy = oy - ay,
          sz = oz - az
        const u = (sx * px + sy * py + sz * pz) * inv
        if (u < 0 || u > 1) continue
        const qx = sy * e1z - sz * e1y,
          qy = sz * e1x - sx * e1z,
          qz = sx * e1y - sy * e1x
        const v = (dx * qx + dy * qy + dz * qz) * inv
        if (v < 0 || u + v > 1) continue
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv
        if (t > 1e-6 && t < best) best = t
      }
    } else {
      stack.push(c0, bvh.child[node * 2 + 1])
    }
  }
  return best === tMax ? Infinity : best
}

// ---------------------------------------------------------------------------
// Variant walk: same outer[pos+pivot, rot, scale] × inner[-pivot] composition as
// buildEntity/composeNodeMatrix, but over BAKED nodes (final pos/rot, degrees).

function bakedNodeMatrix(node: BakedNode, parent: THREE.Matrix4): THREE.Matrix4 {
  const pivot = node.pivot ?? [0, 0, 0]
  const outer = new THREE.Object3D()
  outer.position.set(node.pos[0] + pivot[0], node.pos[1] + pivot[1], node.pos[2] + pivot[2])
  outer.rotation.set(
    THREE.MathUtils.degToRad(node.rot[0]),
    THREE.MathUtils.degToRad(node.rot[1]),
    THREE.MathUtils.degToRad(node.rot[2]),
  )
  if (node.scale !== undefined) {
    if (typeof node.scale === 'number') outer.scale.setScalar(node.scale)
    else outer.scale.set(node.scale[0], node.scale[1], node.scale[2])
  }
  outer.updateMatrix()
  const inner = new THREE.Object3D()
  inner.position.set(-pivot[0], -pivot[1], -pivot[2])
  inner.updateMatrix()
  return new THREE.Matrix4().multiplyMatrices(parent, outer.matrix).multiply(inner.matrix)
}

// Bake AO into every geometry-bearing node of ONE composed variant, in place.
// Occluders: the variant's VISIBLE parts (hidden nodes wait for a state to show
// them — they don't darken the base look) minus aoCast:false opt-outs (rotating
// parts — windmill blades — whose frozen occlusion would smear) minus decals.
// Receivers: every part incl. hidden ones (they need shading when shown).
// Each receiving node gets a per-VARIANT copy of its geom (parts are shared refs
// across variants — writing ao on the shared object would leak between files).
export function bakeVariantAO(variant: BakedVariant): void {
  // pass 1: gather entity-space occluder triangles
  const triChunks: number[] = []
  const v = new THREE.Vector3()
  const walk = (node: BakedNode, parent: THREE.Matrix4, cb: (n: BakedNode, m: THREE.Matrix4) => void): void => {
    const m = bakedNodeMatrix(node, parent)
    cb(node, m)
    for (const child of Object.values(node.children ?? {})) walk(child, m, cb)
  }
  const roots = Object.values(variant.nodes)
  const identity = new THREE.Matrix4()
  for (const root of roots)
    walk(root, identity, (n, m) => {
      if (!n.geom || n.hidden || n.shape === 'decal') return
      const pos = n.geom.positions
      const index = n.geom.index
      const emit = (i: number): void => {
        v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(m)
        triChunks.push(v.x, v.y, v.z)
      }
      if (index.length) for (const i of index) emit(i)
      else for (let i = 0; i < pos.length / 3; i++) emit(i)
    })
  const bvh = buildTriBVH(new Float32Array(triChunks))

  // pass 2: per-vertex hemisphere occlusion for every receiver
  const nrm = new THREE.Vector3()
  const normalMat = new THREE.Matrix3()
  for (const root of roots)
    walk(root, identity, (n, m) => {
      if (!n.geom || n.shape === 'decal') return
      const pos = n.geom.positions
      const normals = n.geom.normals
      const count = pos.length / 3
      const ao = new Array<number>(count)
      normalMat.getNormalMatrix(m)
      for (let i = 0; i < count; i++) {
        v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(m)
        nrm
          .set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2])
          .applyMatrix3(normalMat)
          .normalize()
        // tangent frame around the normal
        let tx: number, ty: number, tz: number
        if (Math.abs(nrm.y) < 0.99) {
          tx = nrm.z
          ty = 0
          tz = -nrm.x
        } // n × up
        else {
          tx = 0
          ty = -nrm.z
          tz = nrm.y
        } // n × right (near-vertical normals)
        const tl = 1 / (Math.hypot(tx, ty, tz) || 1)
        tx *= tl
        ty *= tl
        tz *= tl
        const bx = nrm.y * tz - nrm.z * ty,
          by = nrm.z * tx - nrm.x * tz,
          bz = nrm.x * ty - nrm.y * tx
        const ox = v.x + nrm.x * ORIGIN_EPS,
          oy = v.y + nrm.y * ORIGIN_EPS,
          oz = v.z + nrm.z * ORIGIN_EPS
        let occl = 0
        for (let s = 0; s < SAMPLES; s++) {
          const lx = SAMPLE_DIRS[s * 3],
            ly = SAMPLE_DIRS[s * 3 + 1],
            lz = SAMPLE_DIRS[s * 3 + 2]
          const dx = tx * lx + bx * ly + nrm.x * lz
          const dy = ty * lx + by * ly + nrm.y * lz
          const dz = tz * lx + bz * ly + nrm.z * lz
          let t = closestHit(bvh, ox, oy, oz, dx, dy, dz, MAX_DIST)
          // assumed ground plane at y=0 — models rest there by convention
          if (dy < -1e-6 && oy > 0) {
            const tf = oy / -dy
            if (tf < t) t = tf
          }
          if (t < MAX_DIST) {
            const w = 1 - t / MAX_DIST
            occl += w * w // quadratic falloff — darkening hugs the contact
          }
        }
        const open = 1 - occl / SAMPLES
        ao[i] = Math.max(0, Math.min(255, Math.round(open * 255)))
      }
      weldVertexAO(pos, normals, ao)
      n.geom = { ...n.geom, ao } as AoGeom // per-variant copy — parts are shared across variants
    })
}

// Average AO across position-coincident vertices whose normals agree (same 60°
// crease rule as the normal weld). Non-indexed crafted shapes duplicate every
// corner — without this, adjacent strips/facets of one surface bake slightly
// different corner AO and the interpolation shows as triangular blotches. Real
// creases (plank top vs side) keep their own values — their occlusion genuinely
// differs. Local space: coincidence and angles survive the rigid node transform.
function weldVertexAO(pos: number[], normals: number[], ao: number[]): void {
  const groups = new Map<string, number[]>()
  const count = ao.length
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos[i * 3] * 1e4) || 0},${Math.round(pos[i * 3 + 1] * 1e4) || 0},${Math.round(pos[i * 3 + 2] * 1e4) || 0}`
    const list = groups.get(key)
    if (list) list.push(i)
    else groups.set(key, [i])
  }
  const CREASE = 0.5 // cos 60°
  for (const list of groups.values()) {
    if (list.length < 2) continue
    // greedy-cluster by normal agreement, then average AO per cluster
    const clusters: { nx: number; ny: number; nz: number; members: number[] }[] = []
    for (const i of list) {
      const nx = normals[i * 3],
        ny = normals[i * 3 + 1],
        nz = normals[i * 3 + 2]
      const home = clusters.find((c) => c.nx * nx + c.ny * ny + c.nz * nz > CREASE)
      if (home) home.members.push(i)
      else clusters.push({ nx, ny, nz, members: [i] })
    }
    for (const c of clusters) {
      if (c.members.length < 2) continue
      let sum = 0
      for (const i of c.members) sum += ao[i]
      const avg = Math.round(sum / c.members.length)
      for (const i of c.members) ao[i] = avg
    }
  }
}
