import { AnimationProfileState } from '@inventory/schemas/model.schema'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import {
  AnimationProfile,
  AnimationTask,
  Dying,
  Health,
  IsCorpse,
  IsEnemy,
  IsPlayer,
  NeedsDestroy,
  Position,
  Rotation,
  Velocity,
  writeVec3Row,
} from '@components'

const MODEL = 'pilot_zombie_2'
const CAPACITY = 400 // instance slots, shared by the living and the bodies
const CORPSE_LIMIT = 50
const SPAWN_INTERVAL = 0.25 // seconds
const SPAWN_RADIUS = 18 // metres from the player — outside the camera, in front or behind
const KILL_RADIUS = 1.2
const HEALTH = 1

/*
Spawns enemies, kills them, and decides how long their bodies stay.

Corpses are capped by a queue rather than a timer: the last CORPSE_LIMIT bodies stay, and the one
after that takes the oldest one's slot. The same queue is the pressure valve when the pool runs
dry — a spawn with nowhere to go evicts a corpse instead of failing — so CAPACITY never has to be
guessed exactly right.

Reaching the player is currently fatal to the enemy. That is a placeholder standing in for combat,
and it exists so the death → corpse → eviction path runs continuously instead of only in tests.
*/
export class EnemyLifecycle extends BaseService {
  private world!: KnownServices['world']
  private loader!: KnownServices['loader']
  private skins!: KnownServices['instancedSkinSync']

  private profile!: AnimationProfileState
  private corpses: number[] = [] // oldest first
  private sinceSpawn = 0
  private nextSpawn = SPAWN_INTERVAL

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
    this.loader = registry.get('loader')
    this.skins = registry.get('instancedSkinSync')
  }

  async start() {
    const model = await this.loader.model.load(MODEL)
    if (!model.doc.animationProfile) throw new Error(`EnemyLifecycle: '${MODEL}' has no animation profile`)

    this.profile = model.doc.animationProfile
    this.skins.register(MODEL, model.object, CAPACITY)
  }

  update(dt: number) {
    const { query } = this.world
    const [player] = query([IsPlayer, Position])

    this.settleTheDead()
    if (player === undefined) return

    this.reap(player)

    this.sinceSpawn += dt
    if (this.sinceSpawn < this.nextSpawn) return
    // jittered rather than metronomic, so arrivals do not come in evenly spaced ranks
    this.nextSpawn = SPAWN_INTERVAL * (0.5 + Math.random())
    this.sinceSpawn = 0
    this.spawn(player)
  }

  // a death clip that has played out stops being simulated and becomes scenery
  private settleTheDead() {
    const { query, addComponent, removeComponent } = this.world

    for (const eid of query([Dying])) {
      if (!this.skins.finished(eid)) continue

      removeComponent(eid, Dying)
      addComponent(eid, IsCorpse)
      this.corpses.push(eid)
      while (this.corpses.length > CORPSE_LIMIT) this.bury(this.corpses.shift()!)
    }
  }

  private reap(player: number) {
    const { query, hasComponent } = this.world

    for (const eid of query([IsEnemy, Position])) {
      if (hasComponent(eid, Dying) || hasComponent(eid, IsCorpse)) continue

      const reach = Math.hypot(Position.x[eid] - Position.x[player], Position.z[eid] - Position.z[player])
      if (reach <= KILL_RADIUS) this.kill(eid)
    }
  }

  private kill(eid: number) {
    const { addComponent } = this.world

    Velocity.x[eid] = 0
    Velocity.z[eid] = 0
    addComponent(eid, Dying)

    // locked, so locomotion's per-frame task cannot cut the death short. Nothing releases it —
    // the entity is a corpse by the time the clip ends
    const death = this.profile.lifecycle?.death
    if (!death) return

    addComponent(eid, AnimationTask)
    AnimationTask[eid] = { ...death, repeats: 1, lock: true }
  }

  private spawn(player: number) {
    const { addEntity, removeEntity } = this.world

    const angle = Math.random() * Math.PI * 2
    const x = Position.x[player] + Math.cos(angle) * SPAWN_RADIUS
    const z = Position.z[player] + Math.sin(angle) * SPAWN_RADIUS

    const eid = addEntity(Position, Rotation, Velocity, Health, IsEnemy, AnimationProfile)
    writeVec3Row(Position, eid, [x, 0, z])
    writeVec3Row(Rotation, eid, [0, angle + Math.PI, 0])
    writeVec3Row(Velocity, eid, [0, 0, 0])
    AnimationProfile[eid] = this.profile
    Health[eid] = HEALTH

    if (this.skins.attach(eid, MODEL)) return

    // the pool is full of bodies: the oldest one makes room
    const oldest = this.corpses.shift()
    if (oldest === undefined) return removeEntity(eid) // every slot is a living enemy — skip this spawn

    this.bury(oldest)
    this.skins.attach(eid, MODEL)
  }

  private bury(eid: number) {
    this.skins.detach(eid)
    this.world.addComponent(eid, NeedsDestroy)
  }
}

export type IEnemyLifecycle = InstanceType<typeof EnemyLifecycle>
