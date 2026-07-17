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

// The arena's solid geometry, and who owns it. Systems (player, horde, bolts) hold the
// WORLD, not a naked Box[] — because rooms and doors (docs/GAME.md) mean this set changes
// at runtime, and the array everyone reads must stay the same array when it does.
//
// That was already true and already load-bearing, just unwritten: a bare array was aliased
// into four systems, and "mutate it in place, never reassign" was the sole safe protocol
// with no owner to enforce it and no name to look up. set() is that protocol, said out loud.
export class CollisionWorld {
  // stable identity — never reassigned, so every holder sees every change
  readonly boxes: Box[] = []

  constructor(boxes: Box[] = []) {
    this.set(boxes)
  }

  // replace the world's contents (a new room's walls) without breaking any holder's reference
  set(boxes: Box[]): void {
    this.boxes.length = 0
    this.boxes.push(...boxes)
  }

  clear(): void {
    this.boxes.length = 0
  }

  get empty(): boolean {
    return this.boxes.length === 0
  }
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
// ALLOCATION-FREE: writes the goal into `out` and reuses module scratch for the corners.
// This runs per on-field enemy, per frame, whenever the arena has cover — a fresh result
// object plus a corner array plus a throwaway [box] per box per agent was, by some margin,
// the runtime's largest steady-state garbage source. `pushCircleOut` beside it is the
// pattern. `out` is returned for convenience; it is the same object every call.
const _corners = [
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
]
export function navigateAround(ax: number, az: number, px: number, pz: number, r: number, boxes: Box[], out: { x: number; z: number }): { x: number; z: number } {
  out.x = px
  out.z = pz
  if (segmentEntryT(ax, az, px, pz, boxes) > 1) return out // clear shot to the player
  // the nearest wall on the straight path
  let box: Box | null = null
  let bestT = Infinity
  for (const b of boxes) {
    const t = segmentEntryTBox(ax, az, px, pz, b)
    if (t <= 1 && t < bestT) {
      bestT = t
      box = b
    }
  }
  if (!box) return out
  const m = r + 0.35 // clearance so the agent rounds the corner without clipping it
  _corners[0].x = box.minX - m
  _corners[0].z = box.minZ - m
  _corners[1].x = box.maxX + m
  _corners[1].z = box.minZ - m
  _corners[2].x = box.minX - m
  _corners[2].z = box.maxZ + m
  _corners[3].x = box.maxX + m
  _corners[3].z = box.maxZ + m
  // pick the reachable corner with the shortest detour (agent → corner → player)
  let bestCost = Infinity
  for (const c of _corners) {
    if (segmentEntryT(ax, az, c.x, c.z, boxes) <= 1) continue // can't get to this corner directly
    const cost = Math.hypot(c.x - ax, c.z - az) + Math.hypot(px - c.x, pz - c.z)
    if (cost < bestCost) {
      bestCost = cost
      out.x = c.x
      out.z = c.z
    }
  }
  return out // the best corner, or the player if no corner was reachable
}

// Earliest t in [0,1] at which the XZ segment enters ONE box, or Infinity (slab method).
// Split out from segmentEntryT so a caller that already has a single box needn't wrap it in
// a throwaway array — navigateAround does exactly that, per box, per agent, per frame.
export function segmentEntryTBox(ax: number, az: number, bx: number, bz: number, b: Box): number {
  const dx = bx - ax
  const dz = bz - az
  let tmin = 0
  let tmax = 1
  if (Math.abs(dx) < 1e-9) {
    if (ax < b.minX || ax > b.maxX) return Infinity // parallel and outside the X slab
  } else {
    let t1 = (b.minX - ax) / dx
    let t2 = (b.maxX - ax) / dx
    if (t1 > t2) {
      const s = t1
      t1 = t2
      t2 = s
    }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return Infinity
  }
  if (Math.abs(dz) < 1e-9) {
    if (az < b.minZ || az > b.maxZ) return Infinity
  } else {
    let t1 = (b.minZ - az) / dz
    let t2 = (b.maxZ - az) / dz
    if (t1 > t2) {
      const s = t1
      t1 = t2
      t2 = s
    }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return Infinity
  }
  return tmin
}

// Earliest t in [0,1] at which the XZ segment (ax,az)→(bx,bz) enters ANY box, or Infinity if
// it never does. Used to stop a bolt at the wall it would pass through.
export function segmentEntryT(ax: number, az: number, bx: number, bz: number, boxes: Box[]): number {
  let best = Infinity
  for (const b of boxes) {
    const t = segmentEntryTBox(ax, az, bx, bz, b)
    if (t < best) best = t
  }
  return best
}
