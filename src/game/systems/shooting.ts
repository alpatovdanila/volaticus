import { AnimationClip, BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import {
  AnimationProfile,
  AnimationTask,
  IsPlayer,
  NeedsSpawn,
  Position,
  Projectile,
  Rotation,
  SceneObject,
  Velocity,
  Weapon,
  writeVec3Row,
} from '@components'
import { BASE_WEAPON, WeaponState } from '@lib/weapon'
import { nearestEnemy } from '@lib/nearest-enemy'
import { IDLE_SPEED } from './locomotion-animation'
import { turnToward } from './player-controls'

const AIM_TURN = 12 // radians/sec — faster than walking turns, but still a swing rather than a snap
const MUZZLE_HEIGHT = 1.1 // metres, used only when the model has no hand to fire from

// shared by every bullet: one geometry and one material, however many are in the air. Long on Z
// because that is the axis Rotation.y sweeps, so setting the travel angle aims the streak
const BULLET = new BoxGeometry(0.025, 0.025, 0.35)
const BULLET_MATERIAL = new MeshBasicMaterial({ color: 0xff2b18 })

// resolved once per entity: undefined means "not looked for yet", null means "this rig has none"
const Hand: (Object3D | null)[] = []
const Cycle: number[] = [] // seconds of the shoot clip, as authored

/*
Auto-aim and auto-fire. Standing still is the whole trigger: stop, and the weapon finds the
nearest enemy in range, turns to face it and starts firing at its cadence.

Facing normally belongs to PlayerControls — this system takes it over, but only while it is
actually aiming, and it runs after that one so the override wins on the frames it applies.
*/
export class Shooting extends BaseService {
  private world!: KnownServices['world']
  private sinceVolley: number[] = []
  private muzzle = new Vector3()

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    const { query, hasComponent, addComponent } = this.world

    // the starting weapon, handed out the first time we see a player. Everything after this reads
    // the component, so an upgrade only has to edit that record
    for (const eid of query([IsPlayer])) {
      if (hasComponent(eid, Weapon)) continue
      addComponent(eid, Weapon)
      Weapon[eid] = { ...BASE_WEAPON }
    }

    for (const eid of query([Weapon, Position, Rotation, Velocity])) {
      const weapon = Weapon[eid]
      this.sinceVolley[eid] = (this.sinceVolley[eid] ?? 0) + dt

      if (Math.hypot(Velocity.x[eid], Velocity.z[eid]) >= IDLE_SPEED) continue

      const target = nearestEnemy(this.world, Position.x[eid], Position.z[eid], weapon.range)
      if (target === -1) continue

      const aim = Math.atan2(Position.x[target] - Position.x[eid], Position.z[target] - Position.z[eid])
      Rotation.y[eid] = turnToward(Rotation.y[eid], aim, AIM_TURN * dt)
      this.holdShootPose(eid, weapon)

      if (this.sinceVolley[eid] < 60 / weapon.shotsPerMinute) continue
      this.sinceVolley[eid] = 0
      // fired down the muzzle, not at the target: a shot while the turn is still catching up
      // misses, which is what makes turn speed a real stat
      this.fire(eid, weapon, Rotation.y[eid])
    }
  }

  /*
  Held for as long as the weapon is aiming, not fired once per volley: the clip loops, and
  re-issuing the same one is idempotent in ThreeAnimatorSync, so the pose stays put instead of
  snapping back to frame 0 at every shot.

  Written before LocomotionAnimation runs, which is what makes it win — that system stands down
  for an entity whose task has not been consumed yet. Stop aiming and it takes locomotion back on
  the next frame with no unlocking to do.

  The rate stretches the clip to exactly one cycle per volley, so the animation stays married to
  the fire rate however an upgrade changes it. The doc's own `rate` survives as a correction on
  top, the same way locomotion treats a band's rate.
  */
  private holdShootPose(eid: number, weapon: WeaponState) {
    const shoot = AnimationProfile[eid]?.actions?.shoot
    if (!shoot) return

    const cycle = shootCycle(eid, shoot.clip)
    const perVolley = cycle > 0 ? cycle / (60 / weapon.shotsPerMinute) : 1

    this.world.addComponent(eid, AnimationTask)
    AnimationTask[eid] = { ...shoot, rate: (shoot.rate ?? 1) * perVolley, repeats: Infinity }
  }

  private fire(eid: number, weapon: WeaponState, heading: number) {
    // the shooter's right, for spacing parallel streams apart
    const rightX = Math.cos(heading)
    const rightZ = -Math.sin(heading)

    const step = weapon.shots > 1 ? weapon.fan / (weapon.shots - 1) : 0
    const middle = (weapon.shots - 1) / 2
    this.muzzleOf(eid)

    for (let shot = 0; shot < weapon.shots; shot++) {
      const lane = shot - middle
      const angle = heading + radians(lane * step)
      const x = this.muzzle.x + rightX * lane * weapon.fanOffset
      const z = this.muzzle.z + rightZ * lane * weapon.fanOffset

      for (let pellet = 0; pellet < weapon.bulletsPerShot; pellet++) {
        this.spawn(weapon, x, this.muzzle.y, z, angle + radians(weapon.spread) * (Math.random() * 2 - 1))
      }
    }
  }

  /*
  Where the shot leaves the body: the left hand bone, read from the posed skeleton, so the streak
  starts at the model's hand however it happens to be swinging. Bone matrices are a frame behind
  here — this runs long before the render that updates them — which nothing can see.
  */
  private muzzleOf(eid: number) {
    const bone = hand(eid)
    if (bone) bone.getWorldPosition(this.muzzle)
    else this.muzzle.set(Position.x[eid], MUZZLE_HEIGHT, Position.z[eid])
  }

  private spawn(weapon: WeaponState, x: number, y: number, z: number, angle: number) {
    const eid = this.world.addEntity(Position, Rotation, Velocity, Projectile, SceneObject, NeedsSpawn)

    writeVec3Row(Position, eid, [x, y, z])
    writeVec3Row(Rotation, eid, [0, angle, 0]) // the streak points the way it travels
    writeVec3Row(Velocity, eid, [Math.sin(angle) * weapon.speed, 0, Math.cos(angle) * weapon.speed])

    Projectile[eid] = {
      damage: weapon.damage,
      dismemberChance: weapon.dismemberChance,
      bounces: weapon.bounces,
      bounceRange: weapon.bounceRange,
      travelled: 0,
      range: weapon.range,
      lastTarget: -1,
    }

    // ponytail: one Mesh per bullet, spawned and positioned by the same path level objects use.
    // Instance them when the count in the overlay says it is worth the code
    SceneObject[eid] = new Mesh(BULLET, BULLET_MATERIAL)
  }
}

const radians = (degrees: number) => (degrees * Math.PI) / 180

// 0 when the clip is missing or the entity has no three object to look it up on — the caller then
// leaves the rate alone rather than dividing by nothing
const shootCycle = (eid: number, clip: string): number => {
  if (Cycle[eid] !== undefined) return Cycle[eid]

  Cycle[eid] = AnimationClip.findByName(SceneObject[eid]?.animations ?? [], clip)?.duration ?? 0
  return Cycle[eid]
}

/*
The left hand bone, found once and remembered.

Matched loosely rather than by an exact name: GLTFLoader strips the colon out of mixamo's
`mixamorig:LeftHand`, and the next rig will spell it differently again. Ending in "lefthand" is
enough to pick the hand without also catching LeftHandIndex1 and its siblings.
*/
const hand = (eid: number): Object3D | null => {
  if (Hand[eid] !== undefined) return Hand[eid]

  let found: Object3D | null = null
  SceneObject[eid]?.traverse((object) => {
    if (!found && object.name.replace(/[^a-z]/gi, '').toLowerCase().endsWith('lefthand')) found = object
  })

  if (!found) console.warn(`Shooting: entity ${eid} has no left hand bone — firing from the body`)
  Hand[eid] = found
  return found
}

export type IShooting = InstanceType<typeof Shooting>
