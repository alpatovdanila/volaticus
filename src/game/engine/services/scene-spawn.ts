import { query, removeComponent } from 'bitecs'

import { NeedSpawn, ThreeObject } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

export class SceneSpawn extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(_dt: number) {
    const world = this.world.ecs
    const scene = this.world.scene

    for (const eid of query(world, [ThreeObject, NeedSpawn])) {
      const node = ThreeObject[eid]
      if (node) {
        scene.add(node)
        removeComponent(world, eid, NeedSpawn)
      }
    }
  }
}

export type ISceneSpawn = InstanceType<typeof SceneSpawn>
