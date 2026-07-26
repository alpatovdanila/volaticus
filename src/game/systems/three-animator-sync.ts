import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { ThreeAnimator } from '@components'

/*
Advances every entity's animation mixer. The other half of the ecs↔three boundary from
ThreeSceneSync: that one publishes transforms into three, this one drives three's own clock.

Choosing WHICH clip plays is not this system's job — that belongs to whatever reads
AnimationProfile.
*/
export class ThreeAnimatorSync extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    const { query } = this.world

    // dt is seconds, already clamped by the registry — without that clamp a stalled frame
    // would jump every animation forward by the whole gap
    for (const eid of query([ThreeAnimator])) ThreeAnimator[eid].update(dt)
  }
}

export type IThreeAnimatorSync = InstanceType<typeof ThreeAnimatorSync>
