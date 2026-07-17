// THE SYSTEM — centralized registry of live game parameters. Single source of truth:
// controllers read values from here every frame (never copy them into local constants),
// so anything that changes a parameter at runtime — level-up upgrades, ultimates,
// debuffs, dev tweaking — takes effect instantly everywhere. This is the surface the
// upgrade system (docs/GAME.md) will mutate.
//
// TWO LAYERS, because the registry is deliberately multi-writer:
//
//   base   — what a value IS: authored defaults, permanent upgrades, dev sliders, __sys.
//   params — what a value is RIGHT NOW: base with every active modifier applied. This is
//            the read surface; every consumer reads it every frame, unchanged.
//
// A modifier is named and temporary (an ultimate's buff, the equipped weapon, a debuff).
// It is never "applied" by writing values and "reverted" by writing them back: that's what
// this replaced, and it was a live bug — snapshot the fire rate, buy a +20% fire-rate
// upgrade mid-ultimate, and deactivating the ultimate silently erased the purchase. Now
// the ult pushes {mul:{fireRate:0.5}}, the upgrade writes base, and both survive because
// params is DERIVED from them rather than being a thing anyone owns.
import { RIFLE, type WeaponDef } from './weapons'

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

export type ParamKey = keyof GameParams

// A temporary, named adjustment to the registry. `mul` scales the base value; `set`
// overrides it outright. Both are partial — name only what you change.
export interface Modifier {
  mul?: Partial<GameParams>
  set?: Partial<GameParams>
}

class System {
  // BASE — what the values ARE. Sliders, upgrades and __sys write here.
  readonly base: GameParams = { ...DEFAULT_PARAMS }
  // PARAMS — what the values are RIGHT NOW (base × modifiers). The object identity is
  // stable and its contents are rewritten in place, so every `system.params.x` read
  // anywhere stays live and nothing needs to subscribe to anything.
  readonly params: GameParams = { ...DEFAULT_PARAMS }
  // the gun in the player's hands: a registry entry like any other, because that's what a
  // weapon IS — a set of ballistics modifiers plus the noise it makes (weapons.ts)
  weapon: WeaponDef = RIFLE
  private modifiers = new Map<string, Modifier>()

  // push (or replace) a named modifier — e.g. setModifier('ultimate', {mul:{fireRate:0.5}})
  setModifier(name: string, m: Modifier): void {
    this.modifiers.set(name, m)
    this.recompute()
  }

  clearModifier(name: string): void {
    if (this.modifiers.delete(name)) this.recompute()
  }

  // write a base value (a slider, an upgrade). Goes through here so params re-derives.
  setBase<K extends ParamKey>(key: K, value: GameParams[K]): void {
    this.base[key] = value
    this.recompute()
  }

  // equip a weapon: its ballistics become the 'weapon' modifier. The base rifle declares
  // no modifier — it IS the base — so equipping it simply drops the layer.
  equip(w: WeaponDef): void {
    this.weapon = w
    if (w.mod) this.setModifier('weapon', w.mod)
    else this.clearModifier('weapon')
  }

  // params = base, every `mul` applied, then every `set`. Two passes so an override always
  // beats a scale no matter what order the modifiers were pushed in — order-independence
  // is the point of a stack; if it depended on insertion order it'd just be the old
  // snapshot bug wearing a map.
  private recompute(): void {
    Object.assign(this.params, this.base)
    for (const m of this.modifiers.values()) {
      if (!m.mul) continue
      for (const k of Object.keys(m.mul) as ParamKey[]) this.params[k] *= m.mul[k]!
    }
    for (const m of this.modifiers.values()) {
      if (!m.set) continue
      for (const k of Object.keys(m.set) as ParamKey[]) this.params[k] = m.set[k]!
    }
  }

  // full reset between runs: authored defaults, no modifiers, base weapon
  reset(): void {
    Object.assign(this.base, DEFAULT_PARAMS)
    this.modifiers.clear()
    this.weapon = RIFLE
    this.recompute()
  }
}

export const system = new System()

// dev hook: tweak live from the console — __sys.fireRate = 8, __sys.runSpeedMax = 9 …
// Writes land on BASE (that's what a dev tweak means: change what the value is) and
// re-derive params. Reads report base too, so `__sys.fireRate` echoes what you set even
// while an ultimate is halving the effective rate — read system.params for that.
declare global {
  interface Window {
    __sys: GameParams
  }
}
if (typeof window !== 'undefined') {
  window.__sys = new Proxy(system.base, {
    set(target, key, value: number) {
      if (!(key in target)) throw new Error(`__sys: no such param "${String(key)}"`)
      system.setBase(key as ParamKey, value)
      return true
    },
  })
}
