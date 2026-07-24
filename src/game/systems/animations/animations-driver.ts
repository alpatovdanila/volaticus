import { LoopOnce, LoopRepeat } from 'three'
import { addComponent, hasComponent, observe, onAdd, query, removeComponent } from 'bitecs'

import {
  AnimatorState,
  AnimatorTask,
  IsAnimatorFree,
  LastFinishedAnimationTaskId,
  ThreeAnimator,
} from '../world/model/components'
import { BaseService, IServicesRegistry, KnownServices } from '../../services-registry'

/*
 The animator. Takes commanded playbacks (AnimatorTask) and executes whatever AnimatorState
 says, blindly — producers decide what plays.

 A task occupies the animator: IsAnimatorFree comes off at pickup and returns when the task's
 repeats have run out, holding the last frame until whoever drives the free animator takes
 over. The task is consumed AT pickup, which is what makes re-commanding an already-playing
 clip a clean restart — a task's presence is the command, so it can never be mistaken for the
 one already running.
*/
export class AnimationsDriver extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    const ecs = this.world.ecs

    for (const eid of query(ecs, [ThreeAnimator, AnimatorTask])) {
      const task = AnimatorTask[eid]

      if (!hasComponent(ecs, eid, AnimatorState)) addComponent(ecs, eid, AnimatorState)
      AnimatorState[eid] = { ...task, repeats: task.repeats ?? 1 }

      ThreeAnimator[eid].restartPending = true

      removeComponent(ecs, eid, AnimatorTask)
      removeComponent(ecs, eid, IsAnimatorFree)
    }

    for (const eid of query(ecs, [ThreeAnimator, AnimatorState])) {
      const animator = ThreeAnimator[eid]
      const targetAnimatorState = AnimatorState[eid]

      const targetAction = animator.mixer.clipAction(targetAnimatorState.clip)

      if (!targetAction) {
        console.warn(`Animation: model has no clip "${targetAnimatorState.clip}"`)
        animator.mixer.update(dt)
        continue
      }

      const targetRepeats = targetAnimatorState.repeats || Infinity
      const targetFade = targetAnimatorState.fade ?? 0
      const oneTimer = targetRepeats === 1
      const targetRate = targetAnimatorState.rate ?? 1

      if (animator.currentClip !== targetAnimatorState.clip || animator.restartPending) {
        const previousAction = animator.mixer.clipAction(animator.currentClip)

        targetAction.setLoop(oneTimer ? LoopOnce : LoopRepeat, targetRepeats)

        targetAction.clampWhenFinished = targetRepeats !== Infinity

        targetAction.reset().play()

        if (previousAction && previousAction !== targetAction) {
          targetAction.crossFadeFrom(previousAction, targetFade, false)
        }

        animator.currentClip = targetAnimatorState.clip
        animator.restartPending = false
      }

      targetAction.setEffectiveTimeScale(targetRate)
      animator.mixer.update(dt)

      if (targetAction.paused && !hasComponent(ecs, eid, IsAnimatorFree)) {
        if (targetAnimatorState.taskId !== undefined) {
          if (!hasComponent(ecs, eid, LastFinishedAnimationTaskId)) {
            addComponent(ecs, eid, LastFinishedAnimationTaskId)
          }
          LastFinishedAnimationTaskId[eid] = targetAnimatorState.taskId
        }
        addComponent(ecs, eid, IsAnimatorFree)
      }
    }
  }
}

export type IAnimation = InstanceType<typeof AnimationsDriver>
