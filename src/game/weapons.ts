// Weapons — what a gun IS, in one record each.
//
// This exists because "what a shotgun is" used to be smeared across three files: a
// `pellets > 1` heuristic picking the fire sound, a raw setTimeout for the pump-rack, and
// spread/pellet-count constants sitting next to the ultimate that happened to equip it —
// with the rifle existing only implicitly, as whatever the registry defaults happened to
// say. Adding a weapon meant editing the fire path. Now it's a record.
//
// Ballistics are expressed as a registry Modifier (system.ts), not as numbers the fire
// path reads directly: the same layering that lets an ultimate coexist with a mid-fight
// upgrade applies to the gun you're holding. The rifle declares NO modifier — it is the
// base, and the registry defaults are its stats. That's the single source of truth: there
// is no second place where the rifle's fire rate is written down and could disagree.
import type { Modifier } from './system'

export interface WeaponDef {
  readonly id: string
  readonly sfxShot: string // fired on every trigger pull
  readonly sfxAfter?: string // a beat later — a pump-rack, a reload clack
  readonly afterDelay?: number // s
  // how this weapon bends the registry while equipped; null = it IS the base
  readonly mod: Modifier | null
}

// the starting gun: registry defaults, no layer of its own
export const RIFLE: WeaponDef = {
  id: 'rifle',
  sfxShot: 'shot_rifle',
  mod: null,
}

// ZOMBIE EATER's gun — a wide 12-pellet cone at half the rifle's rate. `mul` on fireRate
// (not `set`) is deliberate: a fire-rate upgrade bought mid-ultimate still applies, since
// half of a faster gun is faster. Spread and pellet count are `set` — they're what the
// weapon IS, not a scaling of the rifle.
export const ZOMBIE_EATER_SHOTGUN: WeaponDef = {
  id: 'zombie_eater_shotgun',
  sfxShot: 'shot_shotgun',
  sfxAfter: 'shotgun_recock',
  afterDelay: 0.28,
  mod: {
    mul: { fireRate: 0.5 },
    set: { bulletSpread: 0.15, pelletsPerShot: 12 }, // cone (the rifle's is 0.05); tightened 25% from 0.2
  },
}
