// THE SYSTEM — centralized registry of live game parameters. Single source of truth:
// controllers read values from here every frame (never copy them into local constants),
// so anything that changes a parameter at runtime — level-up upgrades, ultimates,
// debuffs, dev tweaking — takes effect instantly everywhere. This is the surface the
// upgrade system (docs/GAME.md) will mutate.
export interface GameParams {
  walkSpeedMax: number // m/s at half stick deflection (top of the walk band)
  runSpeedMax: number // m/s at full stick deflection
  zombieSpeed: number // m/s zombie chase speed
  aimDelay: number // s the controller stays in 'settling' after input stops, before it can fire
  fireRate: number // shots per second while standing and engaged
  damage: number // damage dealt by one bolt hit
  dismemberChance: number // 0..1 — chance per landed hit to sever one remaining dismemberable part
  bulletSpread: number // deviation radius in meters per meter traveled (0.05 = 1m at 20m)
  pelletsPerShot: number // bolts spawned per shot (1 = rifle; the shotgun ultimate raises it)
  zombieLightIntensity: number // per-zombie crystal point light (0 = unlit horde)
  aimTurnStiffness: number // rad/s² per rad of error — spring snap toward the aim target
  targetStickiness: number // 0..1 — how hard the auto-aim holds its current target (0 = always nearest)
  stoppingPower: number // speed multiplier applied to a zombie that was hit within stoppingPowerTime
  stoppingPowerTime: number // s — how long a hit keeps a zombie slowed (the flinch window)
  // animation ↔ ground coupling: how many CLIP LOOPS one meter of travel plays.
  // timeScale = speed × lpm × clipDuration — tune until feet grip the ground.
  playerWalkLpm: number
  playerRunLpm: number
  zombieWalkLpm: number
}

export const DEFAULT_PARAMS: GameParams = {
  walkSpeedMax: 1.05,
  runSpeedMax: 2.7,
  zombieSpeed: 0.6009, // 0.475 × 1.1 × 1.15
  aimDelay: 0.15,
  fireRate: 5,
  damage: 0.6325, // 0.5 × 1.1 × 1.15
  dismemberChance: 0.35,
  bulletSpread: 0.05,
  pelletsPerShot: 1,
  zombieLightIntensity: 0.6,
  aimTurnStiffness: 60, // spring-from-rest gives a slow-in/fast/slow-out sweep; ~0.7s + weighty overshoot
  targetStickiness: 0.6, // commit to the locked target; a closer challenger must clearly beat it to steal
  stoppingPower: 0.15, // a freshly-hit zombie crawls at 15% speed…
  stoppingPowerTime: 1, // …for 1s after each hit (sustained fire pins it)
  playerWalkLpm: 0.51, // ≈ current feel: 1 / (1.5 m/s nominal × 1.3s clip)
  playerRunLpm: 0.48, // ≈ 1 / (4.2 × 0.5)
  zombieWalkLpm: 0.85,
}

class System {
  // live values — mutate freely (upgrades do), reset() between runs
  readonly params: GameParams = { ...DEFAULT_PARAMS }

  reset(): void {
    Object.assign(this.params, DEFAULT_PARAMS)
  }
}

export const system = new System()

// dev hook: tweak live from the console — __sys.fireRate = 8, __sys.runSpeedMax = 9 …
declare global {
  interface Window {
    __sys: GameParams
  }
}
if (typeof window !== 'undefined') window.__sys = system.params
