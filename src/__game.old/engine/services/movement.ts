import { query } from 'bitecs'

import { Position, Velocity } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

// Integrates velocity into position. Pure numbers — anything with both components moves.
export class Movement extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    for (const eid of query(this.world.ecs, [Position, Velocity])) {
      Position.x[eid] += Velocity.x[eid] * dt
      Position.y[eid] += Velocity.y[eid] * dt
      Position.z[eid] += Velocity.z[eid] * dt
    }
  }
}

export type IMovement = InstanceType<typeof Movement>
