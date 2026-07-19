import { query } from 'bitecs'

import { AnimationTask, ThreeAnimator } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

/*
 Executes AnimationTask on ThreeAnimator: crossfades to the named clip whenever it changes, over the blend
 duration the task asks for, applies the requested playback rate, and advances the mixer.
*/
export class AnimationsDriver extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    for (const eid of query(this.world.ecs, [ThreeAnimator, AnimationTask])) {
      const animator = ThreeAnimator[eid]
      const task = AnimationTask[eid]
      const action = animator.mixer.clipAction(task.clip)

      if (!action) {
        console.warn(`Animation: model has no clip "${task.clip}"`)
        animator.mixer.update(dt)
        continue
      }

      if (animator.currentClip !== task.clip) {
        const previous = animator.mixer.clipAction(animator.currentClip)
        action.reset().play()
        if (previous) action.crossFadeFrom(previous, task.fade, false)
        animator.currentClip = task.clip
      }

      action.setEffectiveTimeScale(task.rate)
      animator.mixer.update(dt)
    }
  }
}

export type IAnimation = InstanceType<typeof AnimationsDriver>
