import { addComponent, hasComponent, query } from 'bitecs'

import { AnimationTask, LockOn, Locomotion, LocomotionAnimationProfile } from '../world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../../services-registry'

// one knob over every aim-locked clip at once
const LOCKED_RATE_SCALE = 1

/*
 Resolves a movement state into an animation task through whatever LocomotionProfile the entity
 carries: gait picks the clip, and LockOn decides whether the free or the aim-held set is used.

 Knows nothing about who is driving — anything with Locomotion and a profile animates, player or
 AI alike.
*/
export class LocomotionAnimation extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    const ecs = this.world.ecs

    for (const eid of query(ecs, [Locomotion, LocomotionAnimationProfile])) {
      const { gait, direction } = Locomotion[eid]
      const profile = LocomotionAnimationProfile[eid]
      const locked = gait !== 'idle' && hasComponent(ecs, eid, LockOn)

      const state = locked ? profile.locked[gait === 'walk' ? 'walk' : 'run'][direction] : profile.free[gait]

      if (!AnimationTask[eid]) addComponent(ecs, eid, AnimationTask)
      AnimationTask[eid] = {
        clip: state.clip,
        rate: locked ? state.rate * LOCKED_RATE_SCALE : state.rate,
        fade: state.fade,
      }
    }
  }
}

export type ILocomotionAnimation = InstanceType<typeof LocomotionAnimation>
