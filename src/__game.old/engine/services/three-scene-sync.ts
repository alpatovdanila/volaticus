import { query, removeComponent } from 'bitecs'

import { NeedSpawn, Position, Rotation, ThreeObject } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

/*
The boundary between an ECS and the tree js scene - controls spawn/despawn, and positioning
*/
export class ThreeSceneSync extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    for (const eid of query(this.world.ecs, [ThreeObject, NeedSpawn])) {
      const object = ThreeObject[eid]
      if (!object) continue
      this.world.scene.add(object)
      removeComponent(this.world.ecs, eid, NeedSpawn)
    }

    for (const eid of query(this.world.ecs, [ThreeObject, Position, Rotation])) {
      const object = ThreeObject[eid]
      if (!object) continue

      object.position.set(Position.x[eid], Position.y[eid], Position.z[eid])
      object.rotation.set(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid])
    }
  }
}

export type IThreeSceneSync = InstanceType<typeof ThreeSceneSync>
