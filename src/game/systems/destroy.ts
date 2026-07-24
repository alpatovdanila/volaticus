import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { NeedsDestroy } from '@components'

/*
Removes entities tagged NeedsDestroy from the ecs. Nothing else — an entity holding a three
object is despawned first, by whoever destroys it.
*/
export class Destroy extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    const { query, removeEntity } = this.world

    for (const eid of query([NeedsDestroy])) removeEntity(eid)
  }
}

export type IDestroy = InstanceType<typeof Destroy>
