import { addComponent, hasComponent, query } from 'bitecs'

import { AnimationProfile, AnimatorState, IsAnimatorFree, Rotation, Velocity } from '../world/ecs/components'
import type { LocomotionBand, LocomotionSet } from '../../../../../inventory/schemas/model.schema'
import { BaseService, IServicesRegistry, KnownServices } from '../../services-registry'

type LocomotionDirection = 'forward' | 'back' | 'left' | 'right'

/*
 The speed below which a body counts as standing — this system's definition, exported because
 the rest of the game must agree with it: below it no travel direction is resolvable (atan2 of
 ~0 swings around as the body turns) and the idle band plays, so PlayerControl snaps velocity
 to zero against this same line and a profile's lowest moving band starts at it.
*/
export const STANDSTILL_SPEED = 0.05

// the components faces +Z, so `forward x up` puts its right at -X: a positive angle is movement left
const DIRECTION_ANGLE: Record<LocomotionDirection, number> = {
  forward: 0,
  left: Math.PI / 2,
  right: -Math.PI / 2,
  back: Math.PI,
}

const OFF_AXIS = ['back', 'left', 'right'] as const

// shortest signed way around, so -179deg and +179deg read as two degrees apart
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle))

// nearest DECLARED direction: the bucket boundaries are a consequence of which clips the rig
// has, so a one-clip rig answers `forward` for everything and a four-clip rig quarter-splits
const bandsFor = (locomotion: LocomotionSet, heading: number): readonly LocomotionBand[] => {
  let best = locomotion.forward
  let bestDistance = Math.abs(wrap(heading))

  for (const direction of OFF_AXIS) {
    const bands = locomotion[direction]
    if (!bands) continue
    const distance = Math.abs(wrap(heading - DIRECTION_ANGLE[direction]))
    if (distance < bestDistance) {
      bestDistance = distance
      best = bands
    }
  }
  return best
}

// last band whose lower bound has been passed; the first has none and catches everything below
const bandAt = (bands: readonly LocomotionBand[], speed: number): LocomotionBand => {
  for (let i = bands.length - 1; i > 0; i--) if (speed >= (bands[i].above ?? 0)) return bands[i]
  return bands[0]
}

/*
 Turns how an entity is ACTUALLY moving into the clip that depicts it, through whatever profile
 the entity carries. Speed and travel direction are derived from Velocity and Rotation rather
 than published by a controller, so anything that moves a body — input, AI, a knockback impulse
 — animates correctly without knowing this system exists.

 Drives only FREE animators, directly: while a task occupies the animator this system stays
 out, and it takes the channel back the moment the animator comes free.
*/
export class LocomotionAnimation extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    const ecs = this.world.ecs

    for (const eid of query(ecs, [Velocity, Rotation, AnimationProfile, IsAnimatorFree])) {
      const locomotion = AnimationProfile[eid].locomotion
      if (!locomotion) continue // a profile without locomotion does not animate from motion

      const speed = Math.hypot(Velocity.x[eid], Velocity.z[eid])

      // below standstill the travel angle is meaningless — atan2(~0, ~0) swings around as the
      // body turns — so standing is the forward set's lowest band, no direction resolution
      const bands =
        speed < STANDSTILL_SPEED
          ? locomotion.forward
          : bandsFor(locomotion, wrap(Math.atan2(Velocity.x[eid], Velocity.z[eid]) - Rotation.y[eid]))

      const band = bandAt(bands, speed)
      const bandRate = band.rate !== undefined ? band.rate : 1
      if (!hasComponent(ecs, eid, AnimatorState)) addComponent(ecs, eid, AnimatorState)
      AnimatorState[eid] = { clip: band.clip, rate: speed > 0 ? bandRate * speed : band.rate, fade: band.fade }
    }
  }
}

export type ILocomotionAnimation = InstanceType<typeof LocomotionAnimation>
