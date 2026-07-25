import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { NeedsSpawn, SceneObject, Position, Rotation, NeedsDespawn } from '@components'

/*
The boundary between an ECS and the tree js scene - controls spawn/despawn, and positioning
*/
export class ThreeSceneSync extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    const { query, removeComponent, scene } = this.world

    for (const eid of query([SceneObject, NeedsSpawn])) {
      const object = SceneObject[eid]
      if (!object) continue
      scene.worldRoot.add(object)
      removeComponent(eid, NeedsSpawn)
    }

    for (const eid of query([SceneObject, NeedsDespawn])) {
      const object = SceneObject[eid]
      if (!object) continue
      object.removeFromParent()
      removeComponent(eid, NeedsDespawn)
    }

    for (const eid of query([SceneObject, Position, Rotation])) {
      const object = SceneObject[eid]
      if (!object) continue

      object.position.set(Position.x[eid], Position.y[eid], Position.z[eid])
      object.rotation.set(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid])
    }
  }
}

export type IThreeSceneSync = InstanceType<typeof ThreeSceneSync>
