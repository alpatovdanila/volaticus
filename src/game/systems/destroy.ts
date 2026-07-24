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

    // copy: removeEntity swap-pops out of the live query array mid-iteration
    for (const eid of [...query([NeedsDestroy])]) removeEntity(eid)
  }
}

export type IDestroy = InstanceType<typeof Destroy>
