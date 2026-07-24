import { addComponent, hasComponent, query, removeComponent } from 'bitecs'

import { AnimatorState, IsPlayer, LockOn, Position, Rotation, Sprintable, Velocity } from '../world/model/components'
import { STANDSTILL_SPEED } from '../animations/locomotion-animation'
import { BaseService, IServicesRegistry, KnownServices } from '../../services-registry'

// speed at full stick. Sprint raises the CEILING rather than adding a tier — every speed below
// it stays reachable, so enabling sprint never changes how the stick behaves lower down.
const MAX_SPEED = 4.6875
const SPRINT_MAX_SPEED = 7.1875

const TURN_SPEED = 8

/*
 Weight. The stick picks a TARGET speed and velocity chases it exponentially rather than
 snapping, so the body takes time to wind up and keeps carrying after the stick is released.

 A response is a rate, not a duration: time to cover 90% of the remaining gap is ln(10)/r —
 15 is ~0.15s. LOWER IS HEAVIER. The two constants are currently tuned equal; they stay
 separate because winding up and settling are independent feel dials (decel below accel reads
 as momentum, above it as brakes).
*/
const ACCEL_RESPONSE = 15
const DECEL_RESPONSE = 15

const ARENA_CENTRE_X = 0
const ARENA_CENTRE_Z = 0

// short way around: a raw difference sends a +170deg -> -170deg turn the long way
const turnToward = (current: number, target: number, maxStep: number): number => {
  const shortest = Math.atan2(Math.sin(target - current), Math.cos(target - current))
  return Math.abs(shortest) <= maxStep ? target : current + Math.sign(shortest) * maxStep
}

/*
 Drives the player: turns stick input into velocity and facing. Facing follows the direction of
 travel, or LockOn's target while that component is present. Which clip depicts the resulting
 strafe or backpedal is LocomotionAnimation's business, not this file's.

 Stick deflection maps linearly onto a TARGET velocity, which the body then chases, so
 acceleration and stopping carry weight. Facing is still immediate-ish (a constant max turn
 rate) — only translation has inertia.

 It publishes no movement state. Velocity and Rotation are the whole output, and
 LocomotionAnimation derives what to play from them, so nothing here has to know a clip exists —
 which is why the wind-up animates itself: the clip and its rate follow the real speed.

 Speeds are still module constants, so a second character driven by this class would be a
 clone of the first. Making them per-entity is what a stat block is for.
*/
export class PlayerControl extends BaseService {
  private input!: KnownServices['input']
  private world!: KnownServices['world']
  private eventsAnimations!: KnownServices['eventsAnimations']

  init(registry: IServicesRegistry) {
    this.input = registry.get('input')
    this.world = registry.get('world')
    this.eventsAnimations = registry.get('eventsAnimations')
  }

  setSprintable(on: boolean) {
    const ecs = this.world.ecs
    for (const eid of query(ecs, [IsPlayer])) {
      if (on) addComponent(ecs, eid, Sprintable)
      else removeComponent(ecs, eid, Sprintable)
    }
  }

  isSprintable(): boolean {
    const eid = query(this.world.ecs, [IsPlayer])[0]
    return eid !== undefined && hasComponent(this.world.ecs, eid, Sprintable)
  }

  setLocked(on: boolean) {
    const ecs = this.world.ecs
    for (const eid of query(ecs, [IsPlayer])) {
      if (!on) removeComponent(ecs, eid, LockOn)
      else if (!hasComponent(ecs, eid, LockOn)) {
        addComponent(ecs, eid, LockOn)
        LockOn[eid] = { x: ARENA_CENTRE_X, z: ARENA_CENTRE_Z }
      }
    }
  }

  isLocked(): boolean {
    const eid = query(this.world.ecs, [IsPlayer])[0]
    return eid !== undefined && hasComponent(this.world.ecs, eid, LockOn)
  }

  update(dt: number) {
    const { x, z } = this.input.getMove()
    const magnitude = Math.hypot(x, z)
    const ecs = this.world.ecs

    for (const eid of query(ecs, [IsPlayer, Velocity, Rotation, Position])) {
      // test wiring for event animations: button 1 plays the profile's hit react
      if (this.input.wasPressed(1)) this.eventsAnimations.play(eid, 'hit')

      const locked = hasComponent(ecs, eid, LockOn)
      const lock = LockOn[eid]

      // atan2 is scale-invariant, so the raw stick vector gives the same angle as a normalised one
      const facingTarget = locked
        ? Math.atan2(lock.x - Position.x[eid], lock.z - Position.z[eid])
        : magnitude > 0
          ? Math.atan2(x, z)
          : Rotation.y[eid]
      Rotation.y[eid] = turnToward(Rotation.y[eid], facingTarget, TURN_SPEED * dt)

      // where the stick is ASKING the body to go — reached over time, not this frame
      let targetX = 0
      let targetZ = 0
      if (magnitude > 0) {
        const canSprint = hasComponent(ecs, eid, Sprintable) && !locked

        /*
         Deflection IS speed: the stick vector already carries direction and how far it is
         pushed, so it scales straight onto velocity. Walk/run/sprint are no longer speeds the
         body can be in — they are only names for which clip depicts the speed it happens to
         have, and that decision belongs to LocomotionAnimation's bands.
        */
        const top = canSprint ? SPRINT_MAX_SPEED : MAX_SPEED
        targetX = x * top
        targetZ = z * top
      }

      const targetSpeed = Math.hypot(targetX, targetZ)

      // winding up answers faster than winding down, so the body feels driven rather than mushy
      const response = targetSpeed > Math.hypot(Velocity.x[eid], Velocity.z[eid]) ? ACCEL_RESPONSE : DECEL_RESPONSE

      // 1 - exp(-r*dt), not r*dt: a plain lerp would make the weight depend on frame rate
      const chase = 1 - Math.exp(-response * dt)
      Velocity.x[eid] += (targetX - Velocity.x[eid]) * chase
      Velocity.z[eid] += (targetZ - Velocity.z[eid]) * chase

      /*
       Exponential decay never reaches zero, so without this the body coasts at ever-smaller
       fractions of a millimetre forever. Testing the TARGET against a floor rather than against
       exact zero also absorbs a stick resting a hair outside the deadzone — but only a hair:
       anything asking for more than standstill is indistinguishable from a deliberate creep,
       so a genuinely drifting stick is DEADZONE's problem to solve, not this line's.
      */
      if (targetSpeed < STANDSTILL_SPEED && Math.hypot(Velocity.x[eid], Velocity.z[eid]) < STANDSTILL_SPEED) {
        Velocity.x[eid] = 0
        Velocity.z[eid] = 0
      }
    }
  }

  // reads the same components the animator does, so the panel reports what is actually driving
  // the character rather than a parallel copy kept for it
  getDebugState() {
    const ecs = this.world.ecs
    const eid = query(ecs, [IsPlayer, Velocity, Rotation])[0]
    if (eid === undefined) return null

    const current = AnimatorState[eid]
    return {
      locked: hasComponent(ecs, eid, LockOn),
      speed: Math.hypot(Velocity.x[eid], Velocity.z[eid]),
      clip: current?.clip ?? '-',
      rate: current ? (current.rate ?? 1) : 0,
    }
  }
}

export type IPlayerControl = InstanceType<typeof PlayerControl>
