import { LocomotionBand, LocomotionSet } from '@inventory/schemas/model.schema'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { AnimationProfile, AnimationTask, AnimatorLocked, ThreeAnimator, Velocity, Rotation } from '@components'

/*
The clip each entity was last asked for. Private to this system: it exists only so a steady
walk is not re-issued every frame, which would restart the clip and pin it at t=0.
*/
const requested: string[] = []

/*
Turns movement into an animation: world velocity into the entity's own frame, dominant axis into
a direction, speed into a band, band into an AnimationTask.

Reads the profile, never the mixer — starting the clip is ThreeAnimatorSync's job.
*/
export class LocomotionAnimation extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    const { query, hasComponent, addComponent } = this.world

    for (const eid of query([AnimationProfile, Velocity, ThreeAnimator])) {
      const locomotion = AnimationProfile[eid].locomotion
      if (!locomotion) continue

      if (hasComponent(eid, AnimatorLocked)) {
        // the locked clip owns the animator. Forget what we asked for, or when it releases we
        // would still believe that clip is playing and never re-issue — a character frozen
        // mid-idle with nothing obviously wrong
        delete requested[eid]
        continue
      }

      const band = resolveBand(locomotion, eid)
      if (band.clip === requested[eid]) continue

      // endless: a locomotion clip runs until the state changes. It also means locomotion can
      // never take a lock, which is right — only commands should
      AnimationTask[eid] = { ...band, repeats: Infinity }
      addComponent(eid, AnimationTask)
      requested[eid] = band.clip
    }
  }
}

const resolveBand = (locomotion: LocomotionSet, eid: number): LocomotionBand => {
  const vx = Velocity.x[eid]
  const vz = Velocity.z[eid]

  // world → entity frame. Only yaw matters for a character on its feet
  const yaw = Rotation.y[eid]
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const localX = vx * cos - vz * sin
  const localZ = vx * sin + vz * cos

  // three's convention: an object faces -Z, so +X is its right (forward × up)
  const forward = -localZ
  const bands =
    Math.abs(forward) >= Math.abs(localX)
      ? forward >= 0
        ? locomotion.forward
        : locomotion.back
      : localX >= 0
        ? locomotion.right
        : locomotion.left

  // a rig that declares no strafe walks forward rather than freezing. At rest every component
  // is zero, this lands on forward, and forward's first band is the idle
  const set = bands ?? locomotion.forward

  // horizontal speed only — falling must not read as sprinting
  const speed = Math.hypot(vx, vz)

  let band = set[0]
  for (const candidate of set) if (speed >= (candidate.above ?? 0)) band = candidate
  return band
}

export type ILocomotionAnimation = InstanceType<typeof LocomotionAnimation>
