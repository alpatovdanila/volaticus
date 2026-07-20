import { addComponent, hasComponent } from 'bitecs'

import { BaseService, IServicesRegistry, KnownServices } from '../../services-registry'
import {
  AnimatorTask,
  IsAnimatorFree,
  ThreeAnimator,
  type TAnimatorState,
  LastFinishedAnimationTaskId,
} from '../world/ecs/components'

import { AnimationEventName, AnimationProfileState, EventClip } from '../../../../shared/inventory-schema'
import { AnimationProfile } from '../world/ecs/components'

let nextTaskId = 1

const resolve = (profile: AnimationProfileState, name: AnimationEventName): EventClip | undefined => {
  const actions = profile.actions as Partial<Record<AnimationEventName, EventClip>> | undefined
  const lifecycle = profile.lifecycle as Partial<Record<AnimationEventName, EventClip>> | undefined
  return actions?.[name] ?? lifecycle?.[name]
}

export class EventsAnimations extends BaseService {
  protected world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  protected spawn({ eid, ...task }: TAnimatorState & { eid: number }): number {
    const ecs = this.world.ecs
    const taskId = nextTaskId++
    if (!hasComponent(ecs, eid, AnimatorTask)) addComponent(ecs, eid, AnimatorTask)
    AnimatorTask[eid] = { ...task, taskId }
    return taskId
  }

  play(eid: number, name: AnimationEventName): number | null {
    const ecs = this.world.ecs

    if (!hasComponent(ecs, eid, AnimationProfile)) {
      console.warn(`EventsAnimations: entity ${eid} has no animation profile — '${name}' ignored`)
      return null
    }

    const play = resolve(AnimationProfile[eid], name)
    if (!play) {
      console.warn(`EventsAnimations: entity ${eid} profile has no '${name}' animation — ignored`)
      return null
    }

    return this.spawn({ eid, clip: play.clip, rate: play.rate, fade: play.fade, repeats: 1 })
  }

  hasFinished(eid: number, taskId: number): boolean {
    return LastFinishedAnimationTaskId[eid] === taskId
  }
}

export type IEventsAnimations = InstanceType<typeof EventsAnimations>
