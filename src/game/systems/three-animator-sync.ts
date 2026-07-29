import { AnimationAction, LoopRepeat } from 'three'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { AnimationTask, AnimatorLocked, ThreeAnimator } from '@components'

/*
What each entity is currently playing — the action to blend OUT of when the next clip starts.

Private to this system on purpose: it is the only thing allowed to know, and nothing queries on
it, so a registered component would cost a bitflag and buy nothing.
*/
const CurrentAction: AnimationAction[] = []

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

  currentAction(eid: number): AnimationAction | undefined {
    return CurrentAction[eid]
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

    // paired with ThreeAnimator: AnimatorLocked is a shared tag, but only the mixer path stores an
    // action in it — instanced entities lock the same way and release themselves
    for (const eid of query([ThreeAnimator, AnimatorLocked])) {
      const action = AnimatorLocked[eid]
      // three sets paused = true on a clamped finish, and isRunning() tests !paused
      if (action.isRunning()) continue

      action.stop()
      // nothing is playing now: leaving it set would have the next clip crossfade from a
      // stopped action, which blends from nothing and looks like a cut anyway
      delete CurrentAction[eid]
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

      const previous = CurrentAction[eid]
      const fade = task.fade ?? 0

      // idempotent when the same clip re-fires: apply the new rate/loop above and leave the
      // playhead alone. Resetting on every frame would pin an infinitely-looping locomotion
      // clip at t=0; the dedup in the caller then hides the reset by only re-writing on clip
      // change — which is the wrong trade because rate needs to update EVERY frame with speed
      if (previous === action) {
        if (!action.isRunning()) action.play()
        continue
      }

      // opt-in phase carry-over: walk↔run share a cyclic stride, and resetting the new clip to
      // t=0 pops the legs to a random point in their cycle. Mapping the previous playhead onto
      // the new clip's duration keeps stride continuous. Only meaningful between two endless
      // clips, and only the caller knows whether they are actually the same cycle
      if (task.carryPhase && endless && previous && previous.repetitions === Infinity) {
        const from = previous.getClip().duration
        const to = action.getClip().duration
        action.enabled = true // a clip we faded out of earlier was disabled when its weight hit 0
        action.time = from > 0 ? ((previous.time / from) * to) % to : 0
        action.play()
      } else {
        action.reset().play() // crossFadeFrom needs both actions playing
      }
      if (previous) {
        // warp scales the two playback rates into each other over the blend, so a walk→run
        // transition steps through rather than skating
        if (fade > 0) action.crossFadeFrom(previous, fade, true)
        else previous.stop()
      }
      CurrentAction[eid] = action

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
