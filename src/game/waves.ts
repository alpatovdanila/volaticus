// Wave controller — owns WHEN/WHAT/WHERE enemies enter the arena. Levels hand it a
// WaveDef (composition by weight, count range, spawn zones, stagger, pacing) and it
// runs the loop: spawn a staggered wave → wait for the arena to clear → count down →
// next wave. It drives the Horde as an instance POOL (dead enemies are reclaimed and
// re-dressed instead of rebuilt — the path to ~100 live instances later).
import type * as THREE from 'three'
import type { Horde } from './zombies'

export type SpawnZone =
  | { kind: 'ring'; rMin: number; rMax: number } // around the arena center
  | { kind: 'rect'; x: number; z: number; w: number; d: number } // centered box

export interface WaveDef {
  count: [number, number] // zombies per wave, inclusive random range
  spawns: { type: string; weight: number }[] // enemy composition by weight
  zones: SpawnZone[] // spawn positions are sampled uniformly from a random zone
  stagger: [number, number] // per-enemy random spawn delay (desyncs rise animations)
  interWaveDelay: number // seconds between a cleared arena and the next wave
}

// the dev test wave: 7–9 plain zombies rising in a ring around the player
export const TEST_WAVE: WaveDef = {
  count: [7, 9],
  spawns: [{ type: 'alyosha', weight: 1 }],
  zones: [{ kind: 'ring', rMin: 5.5, rMax: 10 }],
  stagger: [0, 1.5],
  interWaveDelay: 4,
}

function samplePoint(zone: SpawnZone): { x: number; z: number } {
  if (zone.kind === 'ring') {
    const a = Math.random() * Math.PI * 2
    const r = zone.rMin + Math.random() * (zone.rMax - zone.rMin)
    return { x: Math.cos(a) * r, z: Math.sin(a) * r }
  }
  return { x: zone.x + (Math.random() - 0.5) * zone.w, z: zone.z + (Math.random() - 0.5) * zone.d }
}

function pickType(spawns: WaveDef['spawns']): string {
  const total = spawns.reduce((s, e) => s + e.weight, 0)
  let roll = Math.random() * total
  for (const e of spawns) {
    roll -= e.weight
    if (roll <= 0) return e.type
  }
  return spawns[spawns.length - 1].type
}

export class WaveController {
  wave = 0
  // gameplay-fact hooks (audio, UI, future XP) — the controller stays policy-only
  onWaveStart: ((wave: number) => void) | null = null
  onCleared: ((wave: number) => void) | null = null
  private countdown = 0
  // 'spawning' exists because spawnAt is async (a dry pool builds a model): the
  // wave-cleared check MUST stay disabled until every spawn has landed, or the empty
  // arena between beginWave() and the first spawn re-triggers the countdown (double waves)
  private state: 'spawning' | 'fighting' | 'countdown' = 'countdown'

  constructor(
    private horde: Horde,
    private def: WaveDef,
  ) {
    this.countdown = 1 // first wave lands a beat after boot
  }

  update(dt: number, _playerPos: THREE.Vector3): void {
    if (this.state === 'spawning') return
    if (this.state === 'fighting') {
      if (this.horde.aliveCount() === 0) {
        this.state = 'countdown'
        this.countdown = this.def.interWaveDelay
        this.onCleared?.(this.wave)
      }
      return
    }
    this.countdown -= dt
    if (this.countdown <= 0) {
      this.state = 'spawning'
      void this.beginWave()
    }
  }

  private async beginWave(): Promise<void> {
    this.wave += 1
    this.onWaveStart?.(this.wave)
    // corpses/chunks are NOT this controller's concern — the remains manager holds
    // custody and budgets them; spawnAt reclaims the oldest corpse if the pool is dry
    const [lo, hi] = this.def.count
    const count = lo + Math.floor(Math.random() * (hi - lo + 1))
    for (let i = 0; i < count; i++) {
      const zone = this.def.zones[(Math.random() * this.def.zones.length) | 0]
      const p = samplePoint(zone)
      const delay = this.def.stagger[0] + Math.random() * (this.def.stagger[1] - this.def.stagger[0])
      await this.horde.spawnAt(pickType(this.def.spawns), p.x, p.z, delay)
    }
    this.state = 'fighting'
  }

  status(): string {
    if (this.state === 'countdown') return `wave ${this.wave + 1} in ${Math.max(0, this.countdown).toFixed(1)}s`
    return `wave ${this.wave}`
  }
}
