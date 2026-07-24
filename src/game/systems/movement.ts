import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { Position, Velocity } from '@components'

/*
Integrates velocity (world units per second) into position. Runs before ThreeSceneSync,
so a position written this frame reaches the three scene in the same frame.
*/
export class Movement extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    const { query } = this.world

    for (const eid of query([Position, Velocity])) {
      Position.x[eid] += Velocity.x[eid] * dt
      Position.y[eid] += Velocity.y[eid] * dt
      Position.z[eid] += Velocity.z[eid] * dt
    }
  }
}

export type IMovement = InstanceType<typeof Movement>
