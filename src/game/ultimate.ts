// Ultimate system — a charge bar that fills with kills and, once full, spends itself on an
// ability that runs until it decides it's spent. Responsibilities are split so new ultimates
// drop in without touching the controller (open/closed):
//   • UltimateAbility — WHAT an ultimate does (apply/revert a buff) and, crucially, WHEN it
//     ends: update() ends it on time, onKill() ends it on a kill condition. Either may fire.
//   • UltimateController — the bar: charge accrual, the ready gate, activation, and polling
//     the ability's end-conditions. It knows nothing about weapons or enemy kinds.
// Abilities layer their effect onto the SYSTEM registry (system.ts is the runtime tuning
// surface upgrades and ultimates modify), so every consumer of the tuned value sees the
// change instantly — and, because the effect is a named modifier rather than a write, an
// upgrade bought mid-ultimate survives the ultimate ending.
import { system } from './system'
import { RIFLE, ZOMBIE_EATER_SHOTGUN } from './weapons'

export interface UltimateAbility {
  readonly name: string
  activate(): void
  deactivate(): void
  update(dt: number): boolean // per-frame tick; true when the ability has run its course (time-based ults)
  onKill(kind: string): boolean // an enemy of `kind` died while active; true when spent (count-based ults)
  hudStatus(): string // short active-state readout for the HUD (e.g. "3/10")
}

// ZOMBIE EATER — swaps the rifle for a wide shotgun and runs until it has EATEN 10
// zombies. Only zombie kills count it down: any OTHER enemy can be blasted for free, so
// used well it shreds a dangerous target while the ult refuses to expire — as long as you
// keep the easy-to-hit zombie horde out of the cone (docs/DD_NOTES.md).
//
// What the gun DOES lives in weapons.ts; this ability's whole job is to decide when you're
// holding it. That's the open/closed line: retuning the shotgun never touches this file.
const GOAL = 10 // zombies to eat before it's spent

export class ZombieEaterUltimate implements UltimateAbility {
  readonly name = 'ZOMBIE EATER'
  private eaten = 0

  activate(): void {
    system.equip(ZOMBIE_EATER_SHOTGUN)
    this.eaten = 0
  }

  deactivate(): void {
    system.equip(RIFLE)
  }

  update(): boolean {
    return false // ZOMBIE EATER ends on zombie kills, never on time
  }

  onKill(kind: string): boolean {
    if (kind !== 'zombie') return false // ONLY zombies are eaten — everything else is free
    this.eaten++
    return this.eaten >= GOAL
  }

  hudStatus(): string {
    return `${this.eaten}/${GOAL}`
  }
}

const MAX_CHARGE = 100
const CHARGE_PER_KILL = 10 // → 10 kills to fill the bar

export class UltimateController {
  private charge = 0
  private active: UltimateAbility | null = null

  constructor(private ability: UltimateAbility) {}

  // kills feed the bar — but ONLY while no ultimate is running. Charging from ult kills
  // would let ZOMBIE EATER (which can farm free non-zombie kills) refill and chain itself
  // forever. While active, kills just feed the ability's own end condition.
  onKill(kind: string): void {
    if (this.active) {
      if (this.active.onKill(kind)) this.deactivate()
    } else {
      this.charge = Math.min(MAX_CHARGE, this.charge + CHARGE_PER_KILL)
    }
  }

  get ready(): boolean {
    return this.charge >= MAX_CHARGE && !this.active
  }

  // spend the bar on the ability; returns whether it fired (ignored when not ready / already active)
  activate(): boolean {
    if (!this.ready) return false
    this.charge = 0
    this.active = this.ability
    this.ability.activate()
    return true
  }

  update(dt: number): void {
    if (this.active && this.active.update(dt)) this.deactivate()
  }

  // end an active ultimate from the outside — a room transition or a run ending must be
  // able to, or the ability's registry layer leaks into whatever comes next. No-op when
  // nothing is running.
  cancel(): void {
    this.deactivate()
  }

  private deactivate(): void {
    this.active?.deactivate()
    this.active = null
  }

  // --- read-only state for the HUD ---
  get chargeValue(): number {
    return this.charge
  }
  get maxCharge(): number {
    return MAX_CHARGE
  }
  get isActive(): boolean {
    return this.active !== null
  }
  get abilityName(): string {
    return this.ability.name
  }
  activeStatus(): string {
    return this.active?.hudStatus() ?? ''
  }
}
