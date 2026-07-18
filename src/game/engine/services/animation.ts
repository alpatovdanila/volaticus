import { query } from 'bitecs'

import { Animator, AnimatorState, InventoryEntityDeclaration, Velocity } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

const CROSSFADE = 0.2

// below this the entity reads as standing still; above it, as running
const IDLE_BELOW = 0.1
const RUN_ABOVE = 4

const play = (animator: AnimatorState, name: string) => {
  if (animator.current === name) return

  const next = animator.actions[name]
  if (!next) return

  const previous = animator.current ? animator.actions[animator.current] : undefined
  next.reset().play()
  if (previous) next.crossFadeFrom(previous, CROSSFADE, true)

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
      }

      animator.mixer.update(dt)
    }
  }
}

export type IAnimation = InstanceType<typeof Animation>
