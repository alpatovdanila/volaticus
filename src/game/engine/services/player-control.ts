import { addComponent, hasComponent, query, removeComponent } from 'bitecs'

import {
  AnimationTask,
  ThreeAnimator,
  IsPlayer,
  LockOn,
  Locomotion,
  LocomotionAnimationProfile,
  Position,
  Rotation,
  Sprintable,
  Velocity,
  type LocomotionDirection,
} from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'
import { BRUNO_LOCOMOTION as playerLocomotionAnimationProfile } from './locomotion-animation/locomotion-profiles'

const WALK_SPEED = 1.5625
const RUN_SPEED = 4.6875
const SPRINT_SPEED = 7.1875

const RUN_AT = 0.55
const SPRINT_AT = 0.9
const TURN_SPEED = 8

const ARENA_CENTRE_X = 0
const ARENA_CENTRE_Z = 0

const QUARTER = Math.PI / 4

// backwards and lateral clips carry a shorter stride, so full speed there would outrun them
const LOCKED_DIRECTION_SPEED: Record<LocomotionDirection, number> = {
  forward: 1,
  back: 0.55,
  left: 0.8,
  right: 0.8,
}

// short way around: a raw difference sends a +170deg -> -170deg turn the long way
const turnToward = (current: number, target: number, maxStep: number): number => {
  const shortest = Math.atan2(Math.sin(target - current), Math.cos(target - current))
  return Math.abs(shortest) <= maxStep ? target : current + Math.sign(shortest) * maxStep
}

// the model faces +Z, so `forward x up` puts its right at -X: a positive angle is movement left
const relativeDirection = (moveYaw: number, facingYaw: number): LocomotionDirection => {
  const d = Math.atan2(Math.sin(moveYaw - facingYaw), Math.cos(moveYaw - facingYaw))
  const a = Math.abs(d)
  if (a <= QUARTER) return 'forward'
  if (a >= 3 * QUARTER) return 'back'
  return d > 0 ? 'left' : 'right'
}

/*
 Drives the player: turns stick input into velocity and facing, publishes the resulting movement
 state to Locomotion for LocomotionAnimation to turn into a clip. Facing follows the direction of
 travel, or LockOn's target while that component is present —
 in which case movement is classified relative to that facing so the strafe and backpedal clips
 are used.

 Everything it decides lives on the entity, so a second controllable character would work
 without touching this class.
*/
export class PlayerControl extends BaseService {
  private input!: KnownServices['input']
  private world!: KnownServices['world']
  private checkedClips = false

  init(registry: IServicesRegistry) {
    this.input = registry.get('input')
    this.world = registry.get('world')
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

    for (const eid of query(ecs, [IsPlayer, Velocity, Rotation, Position, ThreeAnimator])) {
      this.ensureComponents(ecs, eid)

      const locked = hasComponent(ecs, eid, LockOn)
      const lock = LockOn[eid]
      const state = Locomotion[eid]

      const facingTarget = locked
        ? Math.atan2(lock.x - Position.x[eid], lock.z - Position.z[eid])
        : magnitude > 0
          ? Math.atan2(x / magnitude, z / magnitude)
          : Rotation.y[eid]
      Rotation.y[eid] = turnToward(Rotation.y[eid], facingTarget, TURN_SPEED * dt)

      if (magnitude === 0) {
        Velocity.x[eid] = 0
        Velocity.z[eid] = 0
        state.gait = 'idle'
        state.direction = 'forward'
      } else {
        const canSprint = hasComponent(ecs, eid, Sprintable) && !locked
        const gaitSpeed =
          canSprint && magnitude > SPRINT_AT ? SPRINT_SPEED : magnitude > RUN_AT ? RUN_SPEED : WALK_SPEED
        state.gait = gaitSpeed === SPRINT_SPEED ? 'sprint' : gaitSpeed === RUN_SPEED ? 'run' : 'walk'

        const dirX = x / magnitude
        const dirZ = z / magnitude
        state.direction = locked ? relativeDirection(Math.atan2(dirX, dirZ), Rotation.y[eid]) : 'forward'

        const speed = locked ? gaitSpeed * LOCKED_DIRECTION_SPEED[state.direction] : gaitSpeed
        Velocity.x[eid] = dirX * speed
        Velocity.z[eid] = dirZ * speed
      }
    }
  }

  private ensureComponents(ecs: KnownServices['world']['ecs'], eid: number) {
    if (!Locomotion[eid]) {
      addComponent(ecs, eid, Locomotion)
      Locomotion[eid] = { gait: 'idle', direction: 'forward' }
    }
    if (!LocomotionAnimationProfile[eid]) {
      addComponent(ecs, eid, LocomotionAnimationProfile)
      LocomotionAnimationProfile[eid] = playerLocomotionAnimationProfile
    }
    if (!this.checkedClips) this.reportMissingClips(eid)
  }

  // a clip the profile names but the model lacks would freeze the character silently
  private reportMissingClips(eid: number) {
    this.checkedClips = true
    const root = ThreeAnimator[eid]?.mixer.getRoot() as { animations?: { name: string }[] } | undefined
    const profile = LocomotionAnimationProfile[eid]
    if (!root || !profile) return
    const available = new Set((root.animations ?? []).map((c) => c.name))
    const wanted = [
      ...Object.values(profile.free),
      ...Object.values(profile.locked).flatMap((g) => Object.values(g)),
    ].map((s) => s.clip)
    const missing = [...new Set(wanted)].filter((c) => !available.has(c))
    if (missing.length) console.warn(`PlayerControl: model has no clip(s): ${missing.join(', ')}`)
  }

  getDebugState() {
    const eid = query(this.world.ecs, [IsPlayer, Locomotion])[0]
    if (eid === undefined) return null
    const task = AnimationTask[eid]
    return {
      locked: hasComponent(this.world.ecs, eid, LockOn),
      gait: Locomotion[eid].gait,
      direction: Locomotion[eid].direction,
      speed: Math.hypot(Velocity.x[eid], Velocity.z[eid]),
      clip: task?.clip ?? '-',
      rate: task?.rate ?? 0,
    }
  }
}

export type IPlayerControl = InstanceType<typeof PlayerControl>
