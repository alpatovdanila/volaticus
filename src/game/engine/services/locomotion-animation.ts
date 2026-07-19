import { addComponent, hasComponent, query } from 'bitecs'

import {
  AnimationTask,
  LocomotionAnimationProfile,
  Rotation,
  Velocity,
  type LocomotionAnimationProfileState,
  type LocomotionBand,
  type LocomotionDirection,
} from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

/*
 Below this the travel angle is meaningless — atan2(0, 0) is 0, so a standing character would
 resolve to a direction that swings around as it turns. Standing still is the forward set's
 lowest band, no direction resolution at all.
*/
const IDLE_SPEED = 0.05

// the model faces +Z, so `forward x up` puts its right at -X: a positive angle is movement left
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
const bandsFor = (profile: LocomotionAnimationProfileState, heading: number): LocomotionBand[] => {
  let best = profile.forward
  let bestDistance = Math.abs(wrap(heading))

  for (const direction of OFF_AXIS) {
    const bands = profile[direction]
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
const bandAt = (bands: LocomotionBand[], speed: number): LocomotionBand => {
  for (let i = bands.length - 1; i > 0; i--) if (speed >= (bands[i].above ?? 0)) return bands[i]
  return bands[0]
}

/*
 Turns how an entity is ACTUALLY moving into the clip that depicts it, through whatever profile
 the entity carries. Speed and travel direction are derived from Velocity and Rotation rather
 than published by a controller, so anything that moves a body — input, AI, a knockback impulse
 — animates correctly without knowing this system exists.

 Playback rate is speed / the band's nativeSpeed, which is what lets one clip cover a range of
 speeds and keeps the feet on the floor when a character's speed is retuned or modified.
*/
export class LocomotionAnimation extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    const ecs = this.world.ecs

    for (const eid of query(ecs, [Velocity, Rotation, LocomotionAnimationProfile])) {
      const profile = LocomotionAnimationProfile[eid]
      const speed = Math.hypot(Velocity.x[eid], Velocity.z[eid])

      const bands =
        speed < IDLE_SPEED
          ? profile.forward
          : bandsFor(profile, wrap(Math.atan2(Velocity.x[eid], Velocity.z[eid]) - Rotation.y[eid]))

      const band = bandAt(bands, speed)

      if (!hasComponent(ecs, eid, AnimationTask)) addComponent(ecs, eid, AnimationTask)
      AnimationTask[eid] = {
        clip: band.clip,
        rate: band.nativeSpeed > 0 ? speed / band.nativeSpeed : 1,
        fade: band.fade,
      }
    }
  }
}

export type ILocomotionAnimation = InstanceType<typeof LocomotionAnimation>
