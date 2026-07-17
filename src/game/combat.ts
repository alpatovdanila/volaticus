// Combat — everything between "the player is pointing at something" and "that something
// bleeds". Two halves, kept visibly apart:
//
//   PRODUCERS (top)  — aim policy, the fire path, and bolt/target resolution. These decide
//                      what HAPPENED and report it as facts (events.ts).
//   REACTIONS (bottom) — what the facts trigger: blood, sound, sparks, casings, the
//                      ultimate's counter, the hit log. Every one is a subscriber, so
//                      tomorrow's XP/quests/damage-numbers append here instead of editing
//                      the frame loop.
//
// The frame loop stays in main.ts and calls exactly two methods, in this order:
//   chooseTarget(targets) → the aim the player controller then acts on
//   update(dt, now, targets) → advance bolts, resolve hits
// (The gap between them is player.update — that's where shots actually fire.)
import * as THREE from 'three'
import type { GameEvents } from './events'
import type { Horde, EnemyTarget } from './zombies'
import type { PlayerController } from './player'
import type { EffectsManager } from './effectsManager'
import type { BloodSplatters } from './blood'
import type { Casings } from './casings'
import type { UltimateController } from './ultimate'
import type { LightPool } from './lights'
import { Projectiles } from './projectiles'
import { Targeting } from './targeting'
import { segmentEntryT, type Box } from './obstacles'
import { sfx, sfxAt } from './audio'
import { system } from './system'

const FIRE_RANGE = 14 // m — beyond this nothing is worth aiming at
const HIT_LOG_MAX = 120 // dev diagnostic ring (window.__game.hitLog)

export interface CombatDeps {
  scene: THREE.Scene
  events: GameEvents
  horde: Horde
  player: PlayerController
  fx: EffectsManager
  blood: BloodSplatters
  casings: Casings
  ultimate: UltimateController
  obstacles: Box[]
  arenaHalf: number
  boltLights: LightPool | null
}

export class CombatSystem {
  readonly projectiles: Projectiles
  readonly targeting = new Targeting()
  readonly hitLog: string[] = []
  // dev: no aiming, no shooting (tweak animations in peace). The player's immunity is the
  // caller's business — this only stops the guns.
  pacifist = false
  private aimBuf = new THREE.Vector3()
  private pending: { left: number; id: string }[] = [] // sounds owed a beat from now (the recock)

  constructor(private d: CombatDeps) {
    this.projectiles = new Projectiles(d.scene, d.arenaHalf + 0.75, d.boltLights, d.obstacles)
    d.player.onShot = (aim) => this.fire(aim)
    d.player.onStep = () => sfx('footstep') // locomotion owns the cadence (see locomotion.advanceSteps)
    this.wireReactions()
  }

  // --- producers -------------------------------------------------------------

  // aim policy: a valid target is in range AND in line of sight — no aiming or shooting
  // through a wall, which also matches what the bolt would do (it stops on cover). Among
  // the valid ones, the sticky targeter picks which to HOLD (targeting.ts).
  // Returns a point owned by this system; safe to hold for the frame.
  chooseTarget(targets: readonly EnemyTarget[]): THREE.Vector3 | null {
    if (this.pacifist) return null
    const px = this.d.player.position
    const obs = this.d.obstacles
    const cands = targets.filter(
      (t) => t.point.distanceToSquared(px) < FIRE_RANGE * FIRE_RANGE && !(obs.length && segmentEntryT(px.x, px.z, t.point.x, t.point.z, obs) <= 1),
    )
    const p = this.targeting.select(cands, px.x, px.z)
    // copy: the targeter hands back a point the horde owns and rewrites next frame, and
    // the player controller holds this across frames for its aim spring
    return p ? this.aimBuf.copy(p) : null
  }

  // one trigger pull, fired from the animation loop (see player.onShot). The bolts are
  // ours; the noise and the brass are reactions.
  private fire(aim: THREE.Vector3): void {
    const muzzle = this.d.player.muzzle()
    const dir = aim.clone().sub(muzzle)
    // one bolt normally; the shotgun ultimate raises pelletsPerShot — each pellet takes its
    // own spread inside spawn(), so a high count + wide spread reads as a shotgun cone
    const pellets = system.params.pelletsPerShot
    for (let p = pellets; p > 0; p--) this.projectiles.spawn(muzzle, dir)
    this.d.events.emit('shotFired', { muzzle, dir, pellets })
  }

  // advance bolts and resolve what they met. `targets` is the frame's single horde
  // snapshot (main takes it once — the buffer is shared).
  update(dt: number, now: number, targets: readonly EnemyTarget[]): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]
      p.left -= dt
      if (p.left <= 0) {
        sfx(p.id)
        this.pending.splice(i, 1)
      }
    }
    const shots = this.projectiles.update(dt, targets)
    // the horde owns damage and reports the outcome (enemyHit / enemyDied)
    for (const hit of shots.hits) this.d.horde.hit(hit.target, hit.at, hit.dir, now)
    for (const at of shots.walls) this.d.events.emit('wallHit', { at })
  }

  // --- reactions -------------------------------------------------------------

  private wireReactions(): void {
    const { events, fx, blood, casings, ultimate } = this.d

    events.on('shotFired', ({ muzzle, dir }) => {
      fx.muzzleSpark(muzzle, dir) // tiny 1px sparks off the barrel
      casings.eject(muzzle, dir) // one shell per shot, not per pellet
      // the equipped weapon says what it sounds like (weapons.ts) — no guessing from the
      // pellet count, and a weapon with a pump-rack declares its own delay
      const w = system.weapon
      sfx(w.sfxShot)
      if (w.sfxAfter) this.pending.push({ left: w.afterDelay ?? 0.3, id: w.sfxAfter })
    })

    events.on('enemySpawned', ({ at }) => sfxAt('zombie_rise', at.x, at.y, at.z))

    events.on('enemyHit', ({ at, dir, hp, severed }) => {
      fx.bloodHit(at, dir) // spray out the exit wound (the bolt's travel direction)
      blood.splat(at.x, at.z, 0.3 + Math.random() * 0.25, dir) // small floor splatter
      sfxAt('flesh_hit', at.x, at.y, at.z)
      if (severed) sfxAt('dismember', at.x, at.y, at.z)
      this.log(`hp=${hp}${severed ? ' sever:' + severed : ''}`)
    })

    events.on('enemyDied', ({ kind, at }) => {
      sfxAt('zombie_death', at.x, at.y, at.z)
      blood.splat(at.x, at.z, 1.65 + Math.random() * 0.75, undefined, true) // the lingering pool where it fell
      ultimate.onKill(kind) // charges the bar, or feeds an active ult's end condition
      this.log(`DIED (${kind})`)
    })

    events.on('wallHit', ({ at }) => {
      fx.wallSpark(at)
      sfxAt('wall_ricochet', at.x, at.y, at.z)
    })
  }

  // dev diagnostic ring. Wall-clock on purpose: this is for a human reading a timeline
  // next to their own stopwatch, not for the sim.
  private log(msg: string): void {
    this.hitLog.push(`${(performance.now() / 1000).toFixed(2)}s ${msg}`)
    if (this.hitLog.length > HIT_LOG_MAX) this.hitLog.shift()
  }
}
