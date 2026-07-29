/*
What a weapon does, as numbers.

This is the STARTING value only. The live one is Weapon[eid] — a component, so a level-up trait
edits that record and there is no second copy to keep in step.
*/
export type WeaponState = {
  shotsPerMinute: number
  shots: number // simultaneous streams
  fan: number // degrees across all streams; 0 puts every stream on the aim line
  fanOffset: number // metres between stream origins, so parallel streams read as separate
  bulletsPerShot: number // pellets per stream, scattered inside the cone
  spread: number // cone half-angle per pellet, degrees — the miss distance grows with range
  damage: number
  speed: number // m/s
  range: number // metres before a projectile expires; also how far the auto-aim will look
  bounces: number // ricochets to the next enemy after a hit
  bounceRange: number // how far a ricochet looks for its next target
  dismemberChance: number // 0–1 per hit that a part comes off, if the target has any to lose
}

export const BASE_WEAPON: WeaponState = {
  shotsPerMinute: 135,
  shots: 1,
  fan: 0,
  fanOffset: 0.25,
  bulletsPerShot: 1,
  spread: 2,
  damage: 1,
  speed: 16.5,
  range: 16,
  bounces: 4,
  bounceRange: 6,
  dismemberChance: 0.1,
}

// what a projectile carries with it, so a hit can be resolved without asking who fired it
export type ProjectileState = {
  damage: number
  dismemberChance: number
  bounces: number // ricochets left
  bounceRange: number
  travelled: number // metres so far
  range: number
  lastTarget: number // the enemy it is standing inside, so the hit test skips it
}
