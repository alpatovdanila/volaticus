import { query } from 'bitecs'
import type * as THREE from 'three'

import { Animator, AnimatorState, InventoryEntityDeclaration, Velocity } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

// seconds to blend between locomotion clips. Not a mixer setting — three has no such
// property; it is the duration handed to crossFadeFrom below. Raise for a heavier,
// more deliberate character, lower for a twitchier one.
const CROSSFADE = 0.3

// below this the entity reads as standing still; above it, as running
const IDLE_BELOW = 0.1
const RUN_ABOVE = 4

/*
 A locomotion clip covers a fixed distance per loop — baked into userData.rootMotion by the
 fbx merge — so its NATURAL speed is metres-per-loop / seconds-per-loop. Playing it at
 (actual speed / natural speed) is what keeps the feet planted on the ground instead of
 skating: move twice as fast, step twice as often.

 Clips without a profile (idles, reactions, deaths) return 0 and simply play at rate 1.
*/
const naturalSpeed = (clip: THREE.AnimationClip): number => {
  const rootMotion = clip.userData?.rootMotion as { total: number } | undefined
  return rootMotion && clip.duration > 0 ? rootMotion.total / clip.duration : 0
}

// Stretched past these a clip stops reading as the same gait — it becomes a hummingbird or
// a mime. Hitting a clamp is a signal that the movement speed and the clip disagree about
// how fast this character actually travels.
const MIN_RATE = 0.5
const MAX_RATE = 1.8

const play = (animator: AnimatorState, name: string) => {
  if (animator.current === name) return

  const next = animator.actions[name]
  if (!next) return

  const previous = animator.current ? animator.actions[animator.current] : undefined
  next.reset().play()
  // warp=false: warping re-times the clips during the blend to align their durations, which
  // now fights the rate set from movement speed every frame. Speed-matched clips already
  // share a cadence, so there is nothing left for the warp to fix.
  if (previous) next.crossFadeFrom(previous, CROSSFADE, false)

  animator.current = name
}

/*
 Drives each animator from how fast its entity is actually moving, so locomotion follows the
 simulation rather than the input. Clip names come from the entity's own declaration.
*/
export class Animation extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    const ecs = this.world.ecs

    for (const eid of query(ecs, [Animator, Velocity, InventoryEntityDeclaration])) {
      const animator = Animator[eid]
      const locomotion = InventoryEntityDeclaration[eid]?.locomotion

      if (locomotion) {
        const speed = Math.hypot(Velocity.x[eid], Velocity.z[eid])
        const clip = speed < IDLE_BELOW ? locomotion.idle : speed < RUN_ABOVE ? locomotion.walk : locomotion.run
        play(animator, clip)

        // drive the playback rate from how fast the entity is really travelling, so the three
        // phases blend into a continuous gait rather than three fixed-tempo poses
        const action = animator.actions[animator.current]
        if (action) {
          const natural = naturalSpeed(action.getClip())
          const rate = natural > 0 ? Math.min(MAX_RATE, Math.max(MIN_RATE, speed / natural)) : 1
          action.setEffectiveTimeScale(rate)
        }
      }

      animator.mixer.update(dt)
    }
  }
}

export type IAnimation = InstanceType<typeof Animation>
