import { addComponent, hasComponent, query, removeComponent } from 'bitecs'

import { AnimationTask, PlaysAnimationClip } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

// a request to play `clip` over the entity's animation. `remaining` bounds it in seconds;
// null keeps it playing until stop()
export type ScriptedClipRequest = {
  clip: string
  rate: number
  fade: number
  remaining: number | null
}

// claim data, keyed by eid. Membership is the PUBLIC HasAnimationClip mask — this array is
// only ever read behind it, so a stale slot on a recycled eid is unreachable
const claims: ScriptedClipRequest[] = []

/*
 Plays requested clips over entities' animation: play() claims an entity, update() stamps the
 claim's AnimationTask each frame, counts bounded claims down and releases them when they
 expire. Unbounded claims stay until stop().
*/
export class AnimationClips extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  // re-playing an already-claimed entity replaces its claim
  play(eid: number, request: ScriptedClipRequest): void {
    const ecs = this.world.ecs
    if (!hasComponent(ecs, eid, PlaysAnimationClip)) addComponent(ecs, eid, PlaysAnimationClip)
    claims[eid] = { ...request } // copied: `remaining` is counted down in place
  }

  stop(eid: number): void {
    const ecs = this.world.ecs
    if (!hasComponent(ecs, eid, PlaysAnimationClip)) return
    removeComponent(ecs, eid, PlaysAnimationClip)
    delete claims[eid]
  }

  update(dt: number) {
    const ecs = this.world.ecs

    for (const eid of query(ecs, [PlaysAnimationClip])) {
      const claim = claims[eid]

      // the tag was added around play() — anything else is a misuse, healed loudly
      if (!claim) {
        console.warn(`AnimationClips: entity ${eid} tagged without a claim — use play()`)
        removeComponent(ecs, eid, PlaysAnimationClip)
        continue
      }

      if (claim.remaining !== null) {
        claim.remaining -= dt
        if (claim.remaining <= 0) {
          this.stop(eid)
          continue
        }
      }

      if (!hasComponent(ecs, eid, AnimationTask)) addComponent(ecs, eid, AnimationTask)
      AnimationTask[eid] = {
        clip: claim.clip,
        rate: claim.rate,
        fade: claim.fade,
        once: true,
      }
    }
  }
}

export type IAnimationClips = InstanceType<typeof AnimationClips>
