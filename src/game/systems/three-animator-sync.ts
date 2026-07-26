import { LoopRepeat } from 'three'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { AnimationTask, AnimatorLocked, ThreeAnimator } from '@components'

/*
Drives every entity's animation mixer: releases finished locks, starts requested clips, and
advances the clock. The other half of the ecs↔three boundary from ThreeSceneSync — that one
publishes transforms into three, this one drives three's own playback.

Choosing WHICH clip to request is not this system's job; that belongs to whatever reads
AnimationProfile and writes an AnimationTask.
*/
export class ThreeAnimatorSync extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    this.releaseFinishedLocks()
    this.startRequestedClips()

    // dt is seconds, already clamped by the registry — without that clamp a stalled frame
    // would jump every animation forward by the whole gap
    const { query } = this.world
    for (const eid of query([ThreeAnimator])) ThreeAnimator[eid].update(dt)
  }

  /*
  A finished clip hands the animator back. Runs BEFORE start, so an action begun this frame is
  never tested until the next one and cannot release itself before it has played.
  */
  private releaseFinishedLocks() {
    const { query, removeComponent } = this.world

    for (const eid of query([AnimatorLocked])) {
      const action = AnimatorLocked[eid]
      // three sets paused = true on a clamped finish, and isRunning() tests !paused
      if (action.isRunning()) continue

      action.stop()
      removeComponent(eid, AnimatorLocked)
    }
  }

  private startRequestedClips() {
    const { query, addComponent, removeComponent, hasComponent } = this.world

    for (const eid of query([ThreeAnimator, AnimationTask])) {
      const task = AnimationTask[eid]
      removeComponent(eid, AnimationTask) // consumed whether or not it plays

      // the lock means the running clip owns the animator — a hit cannot cut a death short
      if (hasComponent(eid, AnimatorLocked)) continue

      const action = ThreeAnimator[eid].clipAction(task.clip)
      if (!action) {
        console.warn(`ThreeAnimatorSync: entity ${eid} has no clip '${task.clip}'`)
        continue
      }

      const repeats = task.repeats ?? 1
      const endless = !Number.isFinite(repeats)

      action.setLoop(LoopRepeat, repeats)
      action.clampWhenFinished = !endless // hold the last pose rather than snapping to bind
      action.timeScale = task.rate ?? 1

      // NOTE fade is a fade-IN, not a crossfade: blending out of the outgoing clip needs a
      // reference to it, and only the locked action is tracked. Switching clips cuts
      ThreeAnimator[eid].stopAllAction()
      action.reset().fadeIn(task.fade ?? 0).play()

      if (!task.lock) continue
      if (endless) {
        // an animator that can never unlock is worse than one that never locked
        console.warn(`ThreeAnimatorSync: refusing to lock entity ${eid} on endless clip '${task.clip}'`)
        continue
      }

      addComponent(eid, AnimatorLocked)
      AnimatorLocked[eid] = action
    }
  }
}

export type IThreeAnimatorSync = InstanceType<typeof ThreeAnimatorSync>
