// Sticky auto-targeting — decides WHICH of the valid targets the player locks onto. The
// caller (main.ts) filters candidates by policy first (in range, in line-of-sight, not
// pacifist); this only chooses among them, and its whole job is to STOP the constant
// re-acquire thrash: pick a target and hold it until it dies / leaves, switching to a
// nearer one only when that challenger beats the current by a proximity-weighted margin.
// The CLOSER the current target, the harder it is to steal — so an immediate threat gets
// finished instead of abandoned the instant a jostling neighbour edges half a metre closer.
import type * as THREE from 'three'
import { system } from './system'

const STICK_RANGE = 8 // m — beyond this the target isn't "close", so stickiness relaxes to its loose end

export interface Candidate {
  object: THREE.Object3D
  point: THREE.Vector3
}

export class Targeting {
  private current: THREE.Object3D | null = null

  // returns the aim point to fire at, or null to disengage (no valid targets)
  select(candidates: Candidate[], px: number, pz: number): THREE.Vector3 | null {
    let cur: Candidate | null = null
    let curD = Infinity
    let near: Candidate | null = null
    let nearD = Infinity
    for (const c of candidates) {
      const d = Math.hypot(c.point.x - px, c.point.z - pz)
      if (c.object === this.current) {
        cur = c
        curD = d
      }
      if (d < nearD) {
        nearD = d
        near = c
      }
    }
    // lock lost (target died / hid behind a wall / left range) → acquire the nearest
    if (!cur) {
      this.current = near ? near.object : null
      return near ? near.point : null
    }
    // a different, nearer challenger may steal the lock, but only if it clearly beats the
    // current target. The steal ratio k grows with the current target's distance: near → k
    // small (a challenger must be MUCH closer to steal), far → k large (switch more freely).
    if (near && near.object !== this.current) {
      const s = system.params.targetStickiness
      const prox = Math.min(1, curD / STICK_RANGE) // 0 = point-blank, 1 = far
      const k = 1 - s + 0.7 * s * prox // s=0 → k=1 (always nearest); s=0.6 → 0.4 near … 0.82 far
      if (nearD < curD * k) {
        this.current = near.object
        return near.point
      }
    }
    return cur.point // hold the lock
  }
}
