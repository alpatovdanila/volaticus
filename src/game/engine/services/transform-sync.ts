import { query } from 'bitecs'

import { Position, Rotation, ThreeObject } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

/*
 The one place the simulation meets three.js: computed transforms are copied onto the scene
 nodes, once per frame. Every other system works on components alone.
*/
export class TransformSync extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    for (const eid of query(this.world.ecs, [ThreeObject, Position, Rotation])) {
      const object = ThreeObject[eid]
      if (!object) continue
      object.position.set(Position.x[eid], Position.y[eid], Position.z[eid])
      object.rotation.set(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid])
    }
  }
}

export type ITransformSync = InstanceType<typeof TransformSync>
