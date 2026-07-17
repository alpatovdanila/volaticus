// Centralized game-facing effects manager. Call sites ask for MEANING ("blood hit
// here", "wall spark there") and stay dumb; this layer owns the effect definitions
// below and the policies over THEM — throttling, the BUDGETS table, and later distance
// culling / quality scaling. Underneath it drives the shared EffectSystem (pooled
// materials, instanced burst meshes, severed-part chunk pools).
//
// BOUNDARY, because this is not the only budget owner: main.ts hands the Horde the RAW
// EffectSystem, not this manager, so the horde's dismemberment budget (MAX_CHUNKS,
// zombies.ts) is enforced on its own and never passes through here. Two budget owners,
// two injection paths. Route capDismembered through this manager if you want the claim
// to be true — until then, "budgets live here" means the ones in BUDGETS below.
import type * as THREE from 'three'
import { EffectSystem, type EffectDeps } from '../inventory/effects'
import type { EffectDoc } from '../inventory/schema'
import { sim } from './clock'

// -- effect definitions (EffectDoc shape — same format the editor's effects use) --

const BLOOD_HIT: EffectDoc = {
  format: 1,
  id: 'blood-hit',
  name: 'blood hit',
  particles: [
    {
      count: 18,
      size: [0.025, 0.06],
      speed: [1.4, 3],
      dir: 'sphere',
      gravity: -9,
      drag: 1.2,
      life: [0.22, 0.45],
      colors: ['#7a1216', '#a51c22', '#57090c'],
      spin: 7,
    },
  ],
}

const WALL_SPARK: EffectDoc = {
  format: 1,
  id: 'wall-spark',
  name: 'wall spark',
  particles: [
    {
      count: 7,
      size: [0.02, 0.045],
      speed: [2.2, 4.5],
      dir: 'sphere',
      gravity: -11,
      drag: 0.6,
      life: [0.1, 0.28],
      colors: ['#ffd977', '#ffaa33', '#fff3c4'],
      spin: 12,
    },
  ],
}

// muzzle flash — a spray of TINY (~1px) short-lived sparks off the barrel on every shot
const MUZZLE_SPARK: EffectDoc = {
  format: 1,
  id: 'muzzle-spark',
  name: 'muzzle spark',
  particles: [
    {
      count: 5,
      size: [0.005, 0.012], // ~1px at play distance
      speed: [4, 9],
      dir: 'sphere', // biased forward down the barrel via EffectParams.aim
      gravity: -8,
      drag: 3,
      life: [0.03, 0.1], // a flash, gone almost instantly
      colors: ['#fff4cc', '#ffd070', '#ff9a33'],
      spin: 0,
    },
  ],
}

// per-category budget: at most `max` spawns per rolling `window` seconds — a crowd of
// zombies all being hit the same frame degrades to "enough blood", not a particle storm
const BUDGETS: Record<string, { max: number; window: number }> = {
  blood: { max: 8, window: 0.4 },
  spark: { max: 6, window: 0.4 },
  muzzle: { max: 14, window: 0.4 }, // one per shot — generous so rapid/ultimate fire keeps flashing
}

const NOOP_DEPS: EffectDeps = { playSfx: () => {}, addShake: () => {} }

export class EffectsManager {
  private spent = new Map<string, { start: number; n: number }>()

  constructor(
    private fx: EffectSystem,
    private deps: EffectDeps = NOOP_DEPS,
  ) {}

  // dir: the bolt's travel direction — blood sprays out the BACK of the target
  // (exit wound), not a symmetric puff. Bias 1.6 = tight backward cone, some scatter.
  bloodHit(at: THREE.Vector3, dir?: THREE.Vector3): void {
    if (this.allow('blood')) this.fx.play(BLOOD_HIT, at, this.deps, dir ? { aim: dir.clone().setLength(1.6) } : undefined)
  }

  wallSpark(at: THREE.Vector3): void {
    if (this.allow('spark')) this.fx.play(WALL_SPARK, at, this.deps)
  }

  // dir = shot direction; the tiny sparks spray forward off the barrel
  muzzleSpark(at: THREE.Vector3, dir?: THREE.Vector3): void {
    if (this.allow('muzzle')) this.fx.play(MUZZLE_SPARK, at, this.deps, dir ? { aim: dir.clone().setLength(1.8) } : undefined)
  }

  update(dt: number): void {
    this.fx.update(dt)
  }

  private allow(category: string): boolean {
    const b = BUDGETS[category]
    if (!b) return true
    // SIM time: budgets are per unit of GAME time. On wall-clock a pause would silently
    // refill every window, and a frame hitch would hand back a free burst.
    const now = sim.now
    let s = this.spent.get(category)
    if (!s || now - s.start > b.window) {
      s = { start: now, n: 0 }
      this.spent.set(category, s)
    }
    if (s.n >= b.max) return false
    s.n += 1
    return true
  }
}
