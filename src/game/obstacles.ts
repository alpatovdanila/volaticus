// Obstacle collision — axis-aligned box footprints (XZ) for the interior arena walls.
// Kept deliberately tiny and allocation-free: a handful of boxes, tested every frame
// against the player, the horde, and every live bolt. Walls are treated as full-height
// columns (their Y extent doesn't matter — bolts fly within it and agents are on the floor).
export interface Box {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

// build a box from a centre + full width/depth
export function boxFrom(x: number, z: number, w: number, d: number): Box {
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

// Push a circle (centre cx,cz, radius r) out of every box it overlaps. Writes the resolved
// centre into `out`. Cheap iterative resolution — fine for a few boxes; a circle wedged in a
// corner settles over the loop's passes.
export function pushCircleOut(cx: number, cz: number, r: number, boxes: Box[], out: { x: number; z: number }): void {
  out.x = cx
  out.z = cz
  for (const b of boxes) {
    const px = clamp(out.x, b.minX, b.maxX)
    const pz = clamp(out.z, b.minZ, b.maxZ)
    const dx = out.x - px
    const dz = out.z - pz
    const d2 = dx * dx + dz * dz
    if (d2 >= r * r) continue // no overlap with this box
    if (d2 > 1e-8) {
      // centre is outside the box, overlapping an edge/corner → push along the gap
      const d = Math.sqrt(d2)
      const push = r - d
      out.x += (dx / d) * push
      out.z += (dz / d) * push
    } else {
      // centre is inside the box → eject through the nearest face
      const toMinX = out.x - b.minX
      const toMaxX = b.maxX - out.x
      const toMinZ = out.z - b.minZ
      const toMaxZ = b.maxZ - out.z
      const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ)
      if (m === toMinX) out.x = b.minX - r
      else if (m === toMaxX) out.x = b.maxX + r
      else if (m === toMinZ) out.z = b.minZ - r
      else out.z = b.maxZ + r
    }
  }
}

// Route an agent (radius r) toward the player around any wall blocking the direct path.
// Returns the player point when line-of-sight is clear; otherwise the best reachable, cleared
// corner of the blocking wall — head there and the agent flows around it. Greedy and local
// (no nav mesh): fine for a handful of convex walls, and it re-solves every frame, so as soon
// as the agent rounds the corner and regains LOS it heads straight at the player again.
export function navigateAround(ax: number, az: number, px: number, pz: number, r: number, boxes: Box[]): { x: number; z: number } {
  if (segmentEntryT(ax, az, px, pz, boxes) > 1) return { x: px, z: pz } // clear shot to the player
  // the nearest wall on the straight path
  let box: Box | null = null
  let bestT = Infinity
  for (const b of boxes) {
    const t = segmentEntryT(ax, az, px, pz, [b])
    if (t <= 1 && t < bestT) {
      bestT = t
      box = b
    }
  }
  if (!box) return { x: px, z: pz }
  const m = r + 0.35 // clearance so the agent rounds the corner without clipping it
  const corners = [
    { x: box.minX - m, z: box.minZ - m },
    { x: box.maxX + m, z: box.minZ - m },
    { x: box.minX - m, z: box.maxZ + m },
    { x: box.maxX + m, z: box.maxZ + m },
  ]
  // pick the reachable corner with the shortest detour (agent → corner → player)
  let best: { x: number; z: number } | null = null
  let bestCost = Infinity
  for (const c of corners) {
    if (segmentEntryT(ax, az, c.x, c.z, boxes) <= 1) continue // can't get to this corner directly
    const cost = Math.hypot(c.x - ax, c.z - az) + Math.hypot(px - c.x, pz - c.z)
    if (cost < bestCost) {
      bestCost = cost
      best = c
    }
  }
  return best ?? { x: px, z: pz }
}

// Earliest t in [0,1] at which the XZ segment (ax,az)→(bx,bz) enters any box, or Infinity if
// it never does (slab method per box). Used to stop a bolt at the wall it would pass through.
export function segmentEntryT(ax: number, az: number, bx: number, bz: number, boxes: Box[]): number {
  const dx = bx - ax
  const dz = bz - az
  let best = Infinity
  for (const b of boxes) {
    let tmin = 0
    let tmax = 1
    if (Math.abs(dx) < 1e-9) {
      if (ax < b.minX || ax > b.maxX) continue // parallel and outside the X slab
    } else {
      let t1 = (b.minX - ax) / dx
      let t2 = (b.maxX - ax) / dx
      if (t1 > t2) [t1, t2] = [t2, t1]
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) continue
    }
    if (Math.abs(dz) < 1e-9) {
      if (az < b.minZ || az > b.maxZ) continue
    } else {
      let t1 = (b.minZ - az) / dz
      let t2 = (b.maxZ - az) / dz
      if (t1 > t2) [t1, t2] = [t2, t1]
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) continue
    }
    if (tmin < best) best = tmin
  }
  return best
}
