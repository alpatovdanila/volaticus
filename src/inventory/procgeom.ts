// Procedural geometry: planks, posts, rings, and a generic "craftsmanship"
// vertex jitter usable on any shape. craft 1 = machine-perfect, craft 0 =
// crooked hand-hewn. Vertices shift by a deterministic hash of their
// (quantized) position — coincident vertices move together, so faces stay
// sealed. All generators aim for UNIFORM triangle density: edge lengths are
// roughly equal in every direction at a given detail level (side rings and
// concentric cap rings share one spacing derived from the radial segments).
// Pure module (no three.js): used synchronously by the factory in the browser
// AND served by the dev server at /__geom for external tooling.

export interface GeneratedGeometry {
  positions: number[]
  uvs: number[]
  indices: number[]
  // index-space ranges mapped to material slots (post/ring: side/top/bottom)
  groups?: { start: number; count: number; materialIndex: number }[]
}

// shared default cell size for generated lumber (plank grids), meters
export const TARGET_EDGE = 0.22
// radial over-segmentation guard: never place side rings closer than this
const MIN_RING_SPACING = 0.09
const MAX_SIDE_RINGS = 32
const MAX_CAP_RINGS = 12

// deterministic 3D hash -> [-1, 1]^3, stable for coincident vertices
export function hash3(x: number, y: number, z: number, seed: number): [number, number, number] {
  let h = seed | 0
  const q = (v: number) => Math.round(v * 1000)
  h = (Math.imul(h ^ q(x), 0x85ebca6b) ^ Math.imul(h >> 13, 0xc2b2ae35)) | 0
  h = (Math.imul(h ^ q(y), 0x27d4eb2f) ^ Math.imul(h >> 15, 0x165667b1)) | 0
  h = (Math.imul(h ^ q(z), 0x9e3779b9) ^ Math.imul(h >> 16, 0x85ebca6b)) | 0
  const r = (shift: number) => ((h >>> shift) & 0x3ff) / 511.5 - 1
  return [r(0), r(10), r(20)]
}

export function jitterPositions(positions: number[], amount: number, seed: number): void {
  if (amount <= 0) return
  for (let i = 0; i < positions.length; i += 3) {
    const [dx, dy, dz] = hash3(positions[i], positions[i + 1], positions[i + 2], seed)
    positions[i] += dx * amount
    positions[i + 1] += dy * amount
    positions[i + 2] += dz * amount
  }
}

// jitter amount for a shape of a given smallest dimension — capped so large
// meshes (house walls) wobble subtly instead of proportionally
export function craftAmount(craft: number, minDim: number): number {
  return (1 - craft) * Math.min(minDim, 0.6) * 0.28
}

// Midpoint-subdivide a non-indexed triangle soup (each level: 1 tri -> 4).
// Feeds abstract geometry into the jitter: midpoints on an edge shared by two
// triangles land on identical positions, so the positional-hash jitter keeps
// the surface sealed. UVs are lerped alongside. Uniform x4 splits preserve
// edge-length ratios, so a uniform source stays uniform at every level —
// non-uniform sources are fixed at generation time (see factory), never by
// adaptive splitting (which would risk T-junction cracks).
export function subdivideTriangleSoup(
  positions: number[],
  uvs: number[],
  levels: number,
): { positions: number[]; uvs: number[] } {
  let pos = positions
  let uv = uvs
  for (let l = 0; l < levels; l++) {
    const np: number[] = []
    const nu: number[] = []
    const pushV = (i: number, j: number) => {
      // vertex = midpoint of soup vertices i and j (i === j = the vertex itself)
      np.push((pos[i * 3] + pos[j * 3]) / 2, (pos[i * 3 + 1] + pos[j * 3 + 1]) / 2, (pos[i * 3 + 2] + pos[j * 3 + 2]) / 2)
      nu.push((uv[i * 2] + uv[j * 2]) / 2, (uv[i * 2 + 1] + uv[j * 2 + 1]) / 2)
    }
    for (let t = 0; t < pos.length / 9; t++) {
      const a = t * 3, b = a + 1, c = a + 2
      // a, ab, ca / ab, b, bc / ca, bc, c / ab, bc, ca — winding preserved
      pushV(a, a); pushV(a, b); pushV(c, a)
      pushV(a, b); pushV(b, b); pushV(b, c)
      pushV(c, a); pushV(b, c); pushV(c, c)
      pushV(a, b); pushV(b, c); pushV(c, a)
    }
    pos = np
    uv = nu
  }
  return { positions: pos, uvs: uv }
}

// Box subdivided into cells; UVs in meters (tile-style density). Origin at center.
export function generatePlank(w: number, h: number, d: number, craft: number, seed: number): GeneratedGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const dims = [w, h, d]
  const segsFor = (len: number) => Math.max(1, Math.min(6, Math.round(len / TARGET_EDGE)))

  // (uAxis, vAxis) chosen so cross(u, v) == +axis: the sign>0 winding faces outward
  const face = (axis: 0 | 1 | 2, sign: 1 | -1, uAxis: 0 | 1 | 2, vAxis: 0 | 1 | 2) => {
    const su = segsFor(dims[uAxis])
    const sv = segsFor(dims[vAxis])
    const start = positions.length / 3
    for (let iv = 0; iv <= sv; iv++) {
      for (let iu = 0; iu <= su; iu++) {
        const p = [0, 0, 0]
        p[axis] = (sign * dims[axis]) / 2
        p[uAxis] = (iu / su - 0.5) * dims[uAxis]
        p[vAxis] = (iv / sv - 0.5) * dims[vAxis]
        positions.push(p[0], p[1], p[2])
        uvs.push((iu / su) * dims[uAxis], (iv / sv) * dims[vAxis]) // meters
      }
    }
    for (let iv = 0; iv < sv; iv++) {
      for (let iu = 0; iu < su; iu++) {
        const a = start + iv * (su + 1) + iu
        const b = a + 1
        const c = a + (su + 1)
        const e = c + 1
        if (sign > 0) indices.push(a, b, e, a, e, c)
        else indices.push(a, e, b, a, c, e)
      }
    }
  }

  face(0, 1, 1, 2) // +x (y×z = +x)
  face(0, -1, 1, 2)
  face(1, 1, 2, 0) // +y (z×x = +y)
  face(1, -1, 2, 0)
  face(2, 1, 0, 1) // +z (x×y = +z)
  face(2, -1, 0, 1)

  jitterPositions(positions, craftAmount(craft, Math.min(w, h, d)), seed)
  return { positions, uvs, indices }
}

// A plank whose +x end is cut to an arrow point (chisel loft: the cross-section
// keeps its depth but its height tapers linearly to 0 over the last tipLen
// meters — two angled cuts meeting at a point, like a sawn signpost board).
// Same uniform-density grid + meter UVs as generatePlank; the shoulder column
// lands exactly at the taper start so the profile stays crisp. All faces share
// coincident boundary vertices, so the positional-hash jitter keeps every edge
// sealed. Single material group ("all"), origin at center of the w×h×d box.
export function generateArrowPlank(
  w: number,
  h: number,
  d: number,
  craft: number,
  seed: number,
  tip?: number,
): GeneratedGeometry {
  const tipLen = Math.min(tip ?? Math.min(h * 0.9, w * 0.45), w * 0.9)
  const x0 = w / 2 - tipLen
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  // column samples along x: uniform over the rectangle, uniform over the tip,
  // with a column exactly on the shoulder (x0)
  const xs: number[] = []
  const n1 = Math.max(1, Math.min(6, Math.round((w - tipLen) / TARGET_EDGE)))
  for (let i = 0; i <= n1; i++) xs.push(-w / 2 + ((w - tipLen) * i) / n1)
  const n2 = Math.max(1, Math.min(4, Math.round(tipLen / TARGET_EDGE)))
  for (let i = 1; i <= n2; i++) xs.push(x0 + (tipLen * i) / n2)
  const ymax = (x: number) => (x <= x0 ? h / 2 : Math.max(0, ((h / 2) * (w / 2 - x)) / tipLen))
  const sv = Math.max(1, Math.min(6, Math.round(h / TARGET_EDGE)))
  const sd = Math.max(1, Math.min(6, Math.round(d / TARGET_EDGE)))

  // front (+z) / back (-z) pentagon faces: rows collapse toward the apex column
  const pent = (sign: 1 | -1) => {
    const start = positions.length / 3
    for (let i = 0; i < xs.length; i++) {
      const ym = ymax(xs[i])
      for (let j = 0; j <= sv; j++) {
        const y = (j / sv - 0.5) * 2 * ym
        positions.push(xs[i], y, (sign * d) / 2)
        uvs.push(xs[i] + w / 2, y + h / 2) // meters
      }
    }
    for (let i = 0; i < xs.length - 1; i++) {
      const apexRight = ymax(xs[i + 1]) <= 1e-9
      for (let j = 0; j < sv; j++) {
        const a = start + i * (sv + 1) + j
        const c = a + 1
        const b = start + (i + 1) * (sv + 1) + j
        const e = b + 1
        if (apexRight) {
          // right column collapsed to the apex point — one triangle per row
          if (sign > 0) indices.push(a, b, c)
          else indices.push(a, c, b)
        } else if (sign > 0) indices.push(a, b, e, a, e, c)
        else indices.push(a, e, b, a, c, e)
      }
    }
  }
  pent(1)
  pent(-1)

  // top (+y) / bottom (-y) strips follow ymax(x); they meet at the apex edge
  const strip = (sign: 1 | -1) => {
    const start = positions.length / 3
    for (let i = 0; i < xs.length; i++) {
      const y = sign * ymax(xs[i])
      for (let k = 0; k <= sd; k++) {
        const z = (k / sd - 0.5) * d
        positions.push(xs[i], y, z)
        uvs.push(xs[i] + w / 2, z + d / 2) // meters
      }
    }
    for (let i = 0; i < xs.length - 1; i++) {
      for (let k = 0; k < sd; k++) {
        const a = start + i * (sd + 1) + k
        const b = a + 1
        const c = start + (i + 1) * (sd + 1) + k
        const e = c + 1
        if (sign > 0) indices.push(a, b, e, a, e, c)
        else indices.push(a, e, b, a, c, e)
      }
    }
  }
  strip(1)
  strip(-1)

  // left end cap (-x)
  {
    const start = positions.length / 3
    for (let j = 0; j <= sv; j++) {
      const y = (j / sv - 0.5) * h
      for (let k = 0; k <= sd; k++) {
        const z = (k / sd - 0.5) * d
        positions.push(-w / 2, y, z)
        uvs.push(y + h / 2, z + d / 2) // meters
      }
    }
    for (let j = 0; j < sv; j++) {
      for (let k = 0; k < sd; k++) {
        const a = start + j * (sd + 1) + k
        const b = a + 1
        const c = start + (j + 1) * (sd + 1) + k
        const e = c + 1
        indices.push(a, b, e, a, e, c)
      }
    }
  }

  jitterPositions(positions, craftAmount(craft, Math.min(w, h, d)), seed)
  return { positions, uvs, indices }
}

// Extruded 5-point (or n-point) star: front/back faces are triangle fans from
// the center to an alternating outer/inner perimeter, sides are outward quads.
// Star lies in the XY plane (a point straight up), extruded along Z, origin at
// the center. Meter UVs (planar faces, unrolled perimeter sides). Coincident
// perimeter vertices seal front/back/side under the positional-hash jitter.
export function generateStar(
  radius: number,
  innerRatio: number,
  points: number,
  depth: number,
  craft: number,
  seed: number,
): GeneratedGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const n = points * 2
  const rIn = radius * innerRatio
  const hz = depth / 2
  // perimeter, CCW seen from +z, starting with an outer point straight up
  const perim: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const r = k % 2 === 0 ? radius : rIn
    const a = Math.PI / 2 + (k * Math.PI) / points
    perim.push([Math.cos(a) * r, Math.sin(a) * r])
  }

  // BEVELED 3D star (the classic gold-award look): the perimeter sits at z=0 and every
  // rim vertex fans straight to a FRONT and BACK center apex — each point becomes two
  // ridged facets per side, no flat faces, no side walls. Crease welding keeps the
  // facet edges crisp under the global smooth shading.
  const face = (sign: 1 | -1) => {
    const center = positions.length / 3
    positions.push(0, 0, sign * hz)
    uvs.push(radius, radius)
    for (const [x, y] of perim) {
      positions.push(x, y, 0)
      uvs.push(x + radius, y + radius) // meters
    }
    for (let k = 0; k < n; k++) {
      const p0 = center + 1 + k
      const p1 = center + 1 + ((k + 1) % n)
      if (sign > 0) indices.push(center, p0, p1)
      else indices.push(center, p1, p0)
    }
  }
  face(1)
  face(-1)

  jitterPositions(positions, craftAmount(craft, Math.min(radius * 2, depth)), seed)
  return { positions, uvs, indices }
}

// ---------------------------------------------------------------------------
// Recursive low-poly TREE: a wandering tapered trunk, level-1 branches, level-2
// twigs on those, and faceted leaf blobs at every terminal tip. One geometry,
// TWO index groups: 0 = bark (trunk + branches), 1 = leaves — the factory maps
// them to the 'side' / 'top' material faces. UVs are already METERS (bark:
// u around the tube, v along the growth; leaves: blob-local planar-ish).
// Deterministic from `seed` — a different seed is a different tree.
export function generateTree(opts: {
  height: number
  radius: number // trunk base radius
  lushness: number // 0..1 → branch counts + twig recursion density
  spread: number // branch angle from vertical, degrees (birch ~38, oak ~60)
  thickness: number // child/parent radius ratio (oak fatter ~0.7)
  leafSize: number // terminal blob radius (0 = bare tree)
  seed: number
}): GeneratedGeometry {
  const { height, radius, lushness, spread, thickness, leafSize, seed } = opts
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  let s = (seed | 0) || 1
  const rnd = (): number => {
    // xorshift32 → [0, 1)
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 1_000_000) / 1_000_000
  }

  type V3 = [number, number, number]
  const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
  const norm = (a: V3): V3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
  }

  // sweep a tapered tube along a polyline (rings per point, shared frame per ring)
  const tube = (pts: V3[], r0: number, r1: number, radial: number): void => {
    let v = 0
    const ringStart: number[] = []
    for (let i = 0; i < pts.length; i++) {
      const t = i / (pts.length - 1)
      const r = r0 + (r1 - r0) * t
      const dir = norm(
        i === 0 ? add(pts[1], scale(pts[0], -1)) : add(pts[i], scale(pts[i - 1], -1)),
      )
      // orthonormal frame around dir
      const up: V3 = Math.abs(dir[1]) > 0.93 ? [1, 0, 0] : [0, 1, 0]
      const sx = norm([dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]])
      const sz = norm([dir[1] * sx[2] - dir[2] * sx[1], dir[2] * sx[0] - dir[0] * sx[2], dir[0] * sx[1] - dir[1] * sx[0]])
      if (i > 0) v += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2])
      ringStart.push(positions.length / 3)
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2
        const off = add(scale(sx, Math.cos(a) * r), scale(sz, Math.sin(a) * r))
        positions.push(pts[i][0] + off[0], pts[i][1] + off[1], pts[i][2] + off[2])
        uvs.push((k / radial) * 2 * Math.PI * Math.max(r0, 0.02), v)
      }
    }
    for (let i = 0; i < pts.length - 1; i++)
      for (let k = 0; k < radial; k++) {
        const a = ringStart[i] + k
        const b = ringStart[i + 1] + k
        indices.push(a, b, b + 1, a, b + 1, a + 1)
      }
    // tip cap (fan to the end point)
    const tipRing = ringStart[ringStart.length - 1]
    const tip = positions.length / 3
    const last = pts[pts.length - 1]
    positions.push(last[0], last[1], last[2])
    uvs.push(0, v)
    for (let k = 0; k < radial; k++) indices.push(tipRing + k, tip, tipRing + k + 1)
  }

  interface Tip {
    at: V3
    r: number
  }
  const tips: Tip[] = []

  // one branch: curved polyline from `from` along `dir`, optionally recursing
  const branch = (from: V3, dir: V3, len: number, r: number, radial: number, level: number): void => {
    const segs = level === 0 ? 5 : 3
    const pts: V3[] = [from]
    let p = from
    let d = dir
    for (let i = 1; i <= segs; i++) {
      // wander + gentle upward pull on branches (phototropism, reads hand-made)
      d = norm(add(d, [ (rnd() - 0.5) * 0.3, level > 0 ? 0.12 : (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.3 ]))
      p = add(p, scale(d, len / segs))
      pts.push(p)
    }
    tube(pts, r, Math.max(0.012, r * 0.32), radial)
    const end = pts[pts.length - 1]
    if (level === 0) {
      // level-1 branches from the trunk
      const count = Math.round(2 + lushness * 4)
      for (let i = 0; i < count; i++) {
        const t = 0.42 + (0.5 * (i + rnd() * 0.7)) / count
        const at = pts[Math.min(segs, Math.floor(t * segs))]
        const az = i * 2.399 + rnd() * 0.8 // golden-angle spiral
        const pol = ((spread + (rnd() - 0.5) * 24) * Math.PI) / 180
        const bd: V3 = norm([Math.sin(pol) * Math.cos(az), Math.cos(pol), Math.sin(pol) * Math.sin(az)])
        branch(at, bd, len * (0.42 + rnd() * 0.2) * (1.25 - t * 0.5), Math.max(0.02, r * thickness * (1 - t * 0.4)), 5, 1)
      }
      tips.push({ at: end, r: Math.max(0.02, r * 0.3) })
    } else if (level === 1 && lushness > 0.25) {
      // level-2 twigs
      const count = Math.max(1, Math.round(lushness * 2.6))
      for (let i = 0; i < count; i++) {
        const t = 0.45 + (0.45 * i) / count
        const at = pts[Math.min(segs, Math.max(1, Math.floor(t * segs)))]
        const az = rnd() * Math.PI * 2
        const pol = ((spread * 0.85 + (rnd() - 0.5) * 30) * Math.PI) / 180
        const bd: V3 = norm([Math.sin(pol) * Math.cos(az), Math.cos(pol), Math.sin(pol) * Math.sin(az)])
        branch(at, bd, len * (0.45 + rnd() * 0.2), Math.max(0.014, r * thickness), 4, 2)
      }
      tips.push({ at: end, r })
    } else {
      tips.push({ at: end, r })
    }
  }

  branch([0, 0, 0], [0, 1, 0], height, radius, 7, 0)
  const barkCount = indices.length

  // leaf blobs: one faceted squashed sphere per terminal tip
  if (leafSize > 0) {
    for (const tip of tips) {
      const r = leafSize * (0.75 + rnd() * 0.55)
      const segs = 6
      const rows = 4
      const base = positions.length / 3
      for (let row = 0; row <= rows; row++) {
        const th = (row / rows) * Math.PI
        for (let k = 0; k <= segs; k++) {
          const a = (k / segs) * Math.PI * 2
          const jx = (rnd() - 0.5) * r * 0.25
          const px = tip.at[0] + Math.sin(th) * Math.cos(a) * r + jx
          const py = tip.at[1] + Math.cos(th) * r * 0.8
          const pz = tip.at[2] + Math.sin(th) * Math.sin(a) * r
          positions.push(px, py, pz)
          uvs.push((k / segs) * 2 * r, (row / rows) * 2 * r)
        }
      }
      for (let row = 0; row < rows; row++)
        for (let k = 0; k < segs; k++) {
          const a = base + row * (segs + 1) + k
          const b = a + segs + 1
          indices.push(a, b, b + 1, a, b + 1, a + 1)
        }
    }
  }
  return {
    positions,
    uvs,
    indices,
    groups: [
      { start: 0, count: barkCount, materialIndex: 0 },
      { start: barkCount, count: indices.length - barkCount, materialIndex: 1 },
    ],
  }
}

// Tapered tube with UNIFORM density: side ring spacing == circumferential edge
// length (set by radialSegs), caps are concentric rings at the same spacing
// (never a single center fan). radiusTop 0 = cone (side ends in an apex fan,
// no top cap). Vertex layout follows the three.js cylinder convention
// (x = r·sinθ, z = r·cosθ), so generated and THREE-built cylinders in one
// entity keep their facet corners aligned.
// Groups: side (0), then top cap (1) and bottom cap (2) — for a cone the
// bottom cap gets materialIndex 1 (matching the factory's side/bottom pair).
// uvMeters: post-style side UVs in meters + motif 0..1 caps; default is
// three.js-normalized UVs (the factory retiles them per material).
// bulge (opts.bulge, meters): adds a barrel-belly to the side profile — the
// radius gains bulge·sin(π·t), so it's 0 at both rims and peaks at mid-height,
// turning a straight frustum into a smoothly curved cask across all side rings.
export function generateTube(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegs: number,
  opts: { open?: boolean; uvMeters?: boolean; bulge?: number } = {},
): GeneratedGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const groups: { start: number; count: number; materialIndex: number }[] = []
  const isCone = radiusTop <= 0
  const rTop = Math.max(radiusTop, 0)
  const avgR = (rTop + radiusBottom) / 2
  const bulge = opts.bulge ?? 0
  // spacing derives from the FATTEST profile radius so a bulged cask keeps its
  // circumferential edge length ~= its ring spacing (uniform facets top to belly).
  const spacing = Math.max((2 * Math.PI * (avgR + bulge)) / radialSegs, MIN_RING_SPACING)
  const rings = Math.max(1, Math.min(MAX_SIDE_RINGS, Math.round(height / spacing)))

  // side: rings bottom -> top
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings
    const y = (t - 0.5) * height
    const r = radiusBottom + (rTop - radiusBottom) * t + bulge * Math.sin(Math.PI * t)
    for (let i = 0; i <= radialSegs; i++) {
      const a = (i / radialSegs) * Math.PI * 2
      positions.push(Math.sin(a) * r, y, Math.cos(a) * r)
      if (opts.uvMeters) uvs.push((i / radialSegs) * 2 * Math.PI * avgR, t * height) // meters
      else uvs.push(i / radialSegs, t)
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let i = 0; i < radialSegs; i++) {
      const a = ring * (radialSegs + 1) + i
      const b = a + 1
      const c = a + (radialSegs + 1)
      const e = c + 1
      // cone apex band: the top ring collapses to a point — emit a fan
      if (isCone && ring === rings - 1) indices.push(a, b, c)
      else indices.push(a, b, c, b, e, c)
    }
  }
  groups.push({ start: 0, count: indices.length, materialIndex: 0 })

  // caps: own vertices, concentric rings at the side spacing. The outermost
  // ring lands exactly on the side rim vertices, so positional-hash jitter
  // keeps cap and side sealed.
  const cap = (top: boolean, materialIndex: number) => {
    const r = top ? rTop : radiusBottom
    if (r <= 0) return
    const start = indices.length
    const y = (top ? 0.5 : -0.5) * height
    const sign = top ? 1 : -1
    const capRings = Math.max(1, Math.min(MAX_CAP_RINGS, Math.round(r / spacing)))
    const center = positions.length / 3
    positions.push(0, y, 0)
    uvs.push(0.5, 0.5)
    const ringStart: number[] = []
    for (let j = 1; j <= capRings; j++) {
      ringStart.push(positions.length / 3)
      const rj = (r * j) / capRings
      for (let i = 0; i <= radialSegs; i++) {
        const a = (i / radialSegs) * Math.PI * 2
        const px = Math.sin(a) * rj
        const pz = Math.cos(a) * rj
        positions.push(px, y, pz)
        // planar cap UVs; motif (post tree-rings) ignores the bottom flip
        if (opts.uvMeters) uvs.push(0.5 + (px / r) * 0.5, 0.5 + (pz / r) * 0.5)
        else uvs.push((px / r) * 0.5 + 0.5, ((pz / r) * 0.5) * sign + 0.5)
      }
    }
    const r1 = ringStart[0]
    for (let i = 0; i < radialSegs; i++) {
      if (top) indices.push(center, r1 + i, r1 + i + 1)
      else indices.push(center, r1 + i + 1, r1 + i)
    }
    for (let j = 0; j < capRings - 1; j++) {
      const inner = ringStart[j]
      const outer = ringStart[j + 1]
      for (let i = 0; i < radialSegs; i++) {
        if (top) indices.push(inner + i, outer + i, outer + i + 1, inner + i, outer + i + 1, inner + i + 1)
        else indices.push(inner + i, outer + i + 1, outer + i, inner + i, inner + i + 1, outer + i + 1)
      }
    }
    groups.push({ start, count: indices.length - start, materialIndex })
  }
  if (!opts.open) {
    if (!isCone) cap(true, 1)
    cap(false, isCone ? 1 : 2)
  }
  return { positions, uvs, indices, groups }
}

// A single flat circular face lying in the XZ plane at y=0, normal +Y — the
// disk equivalent of a cylinder's top cap: concentric rings at the uniform side
// spacing (never a lone center fan), one material group ('all'), NO rim and NO
// underside. For container floors / content surfaces that should read as one
// plane instead of a solid slab. UVs are planar 0..1 across the diameter (the
// factory's uvProject re-meters as usual). craft 1 / seed 0 from the factory —
// entity-space craft jitter is layered on afterward, like the other generators.
export function generateDisk(radius: number, radialSegs: number, craft: number, seed: number): GeneratedGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const spacing = Math.max((2 * Math.PI * radius) / radialSegs, MIN_RING_SPACING)
  const capRings = Math.max(1, Math.min(MAX_CAP_RINGS, Math.round(radius / spacing)))
  const center = positions.length / 3
  positions.push(0, 0, 0)
  uvs.push(0.5, 0.5)
  const ringStart: number[] = []
  for (let j = 1; j <= capRings; j++) {
    ringStart.push(positions.length / 3)
    const rj = (radius * j) / capRings
    for (let i = 0; i <= radialSegs; i++) {
      const a = (i / radialSegs) * Math.PI * 2
      const px = Math.sin(a) * rj
      const pz = Math.cos(a) * rj
      positions.push(px, 0, pz)
      uvs.push((px / radius) * 0.5 + 0.5, (pz / radius) * 0.5 + 0.5)
    }
  }
  const r1 = ringStart[0]
  for (let i = 0; i < radialSegs; i++) indices.push(center, r1 + i, r1 + i + 1) // +Y-facing fan
  for (let j = 0; j < capRings - 1; j++) {
    const inner = ringStart[j]
    const outer = ringStart[j + 1]
    for (let i = 0; i < radialSegs; i++) {
      indices.push(inner + i, outer + i, outer + i + 1, inner + i, outer + i + 1, inner + i + 1)
    }
  }
  jitterPositions(positions, craftAmount(craft, radius * 2), seed)
  return { positions, uvs, indices, groups: [{ start: 0, count: indices.length, materialIndex: 0 }] }
}

// A hand-hewn post/stick: uniform tube + tree-ring motif caps, side UVs in
// meters. Groups: side (0) / top (1) / bottom (2), like a cylinder.
// NOTE: the factory calls this with craft 1 (no baked jitter) and applies its
// own entity-space craft pass; the local jitter here serves /__geom.
export function generatePost(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegs: number,
  craft: number,
  seed: number,
): GeneratedGeometry {
  const g = generateTube(radiusTop, radiusBottom, height, radialSegs, { uvMeters: true })
  jitterPositions(g.positions, craftAmount(craft, Math.min(2 * Math.max(radiusTop, radiusBottom), height)), seed)
  return g
}

// Closed annular band with real wall thickness: outer shell + inner shell +
// top/bottom annulus caps — thin metal (barrel bands, bucket walls, rims) you
// cannot see through from any angle. Same uniform density rules as the tube.
// Groups: side = outer+inner shells (0) / top (1) / bottom (2).
export function generateRing(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  thickness: number,
  radialSegs: number,
  craft: number,
  seed: number,
): GeneratedGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const avgR = (radiusTop + radiusBottom) / 2
  const spacing = Math.max((2 * Math.PI * avgR) / radialSegs, MIN_RING_SPACING)
  const rings = Math.max(1, Math.min(MAX_SIDE_RINGS, Math.round(height / spacing)))
  const inTop = Math.max(radiusTop - thickness, 0.001)
  const inBottom = Math.max(radiusBottom - thickness, 0.001)

  const shell = (rT: number, rB: number, inward: boolean) => {
    const start = positions.length / 3
    for (let ring = 0; ring <= rings; ring++) {
      const t = ring / rings
      const y = (t - 0.5) * height
      const r = rB + (rT - rB) * t
      for (let i = 0; i <= radialSegs; i++) {
        const a = (i / radialSegs) * Math.PI * 2
        positions.push(Math.sin(a) * r, y, Math.cos(a) * r)
        uvs.push(i / radialSegs, t)
      }
    }
    for (let ring = 0; ring < rings; ring++) {
      for (let i = 0; i < radialSegs; i++) {
        const a = start + ring * (radialSegs + 1) + i
        const b = a + 1
        const c = a + (radialSegs + 1)
        const e = c + 1
        if (inward) indices.push(a, c, b, b, c, e)
        else indices.push(a, b, c, b, e, c)
      }
    }
  }
  shell(radiusTop, radiusBottom, false)
  shell(inTop, inBottom, true)
  const sideCount = indices.length

  // annulus caps: radial strips from the inner rim to the outer rim; rim rows
  // coincide with the shell end rings, so jitter keeps every edge sealed
  const cap = (top: boolean) => {
    const start = indices.length
    const y = (top ? 0.5 : -0.5) * height
    const rOut = top ? radiusTop : radiusBottom
    const rIn = top ? inTop : inBottom
    const steps = Math.max(1, Math.min(8, Math.round((rOut - rIn) / spacing)))
    const rowStart: number[] = []
    for (let j = 0; j <= steps; j++) {
      rowStart.push(positions.length / 3)
      const rj = rIn + ((rOut - rIn) * j) / steps
      for (let i = 0; i <= radialSegs; i++) {
        const a = (i / radialSegs) * Math.PI * 2
        const px = Math.sin(a) * rj
        const pz = Math.cos(a) * rj
        positions.push(px, y, pz)
        uvs.push((px / rOut) * 0.5 + 0.5, ((pz / rOut) * 0.5) * (top ? 1 : -1) + 0.5)
      }
    }
    for (let j = 0; j < steps; j++) {
      const inner = rowStart[j]
      const outer = rowStart[j + 1]
      for (let i = 0; i < radialSegs; i++) {
        if (top) indices.push(inner + i, outer + i, outer + i + 1, inner + i, outer + i + 1, inner + i + 1)
        else indices.push(inner + i, outer + i + 1, outer + i, inner + i, inner + i + 1, outer + i + 1)
      }
    }
    return indices.length - start
  }
  const topCount = cap(true)
  const bottomCount = cap(false)

  jitterPositions(positions, craftAmount(craft, Math.min(2 * Math.max(radiusTop, radiusBottom), height)), seed)
  return {
    positions,
    uvs,
    indices,
    groups: [
      { start: 0, count: sideCount, materialIndex: 0 },
      { start: sideCount, count: topCount, materialIndex: 1 },
      { start: sideCount + topCount, count: bottomCount, materialIndex: 2 },
    ],
  }
}
