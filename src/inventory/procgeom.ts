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

  const face = (sign: 1 | -1) => {
    const center = positions.length / 3
    positions.push(0, 0, sign * hz)
    uvs.push(radius, radius)
    for (const [x, y] of perim) {
      positions.push(x, y, sign * hz)
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

  // sides: one outward quad per perimeter edge, u = unrolled edge length
  let u = 0
  for (let k = 0; k < n; k++) {
    const [x0, y0] = perim[k]
    const [x1, y1] = perim[(k + 1) % n]
    const len = Math.hypot(x1 - x0, y1 - y0)
    const start = positions.length / 3
    positions.push(x0, y0, hz, x0, y0, -hz, x1, y1, -hz, x1, y1, hz)
    uvs.push(u, depth, u, 0, u + len, 0, u + len, depth) // meters
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
    u += len
  }

  jitterPositions(positions, craftAmount(craft, Math.min(radius * 2, depth)), seed)
  return { positions, uvs, indices }
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
