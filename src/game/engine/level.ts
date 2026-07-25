import { BoxGeometry, Mesh, MeshNormalMaterial } from 'three'

import { NeedsSpawn, Position, Rotation, SceneObject, Velocity } from '@components'
import { BaseService, IServicesRegistry, KnownServices } from './services-registry'

export class Level extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  async start() {
    this.world.camera.position.set(0, 0, 6)

    // SCAFFOLDING for the movement system — one cube drifting along +x.
    // Delete once the level loader builds the scene for real.
    // Rotation is required: ThreeSceneSync's transform query is [SceneObject, Position, Rotation]
    const eid = this.world.addEntity(Position, Rotation, Velocity, SceneObject, NeedsSpawn)
    SceneObject[eid] = new Mesh(new BoxGeometry(1, 1, 1), new MeshNormalMaterial())
    Position.x[eid] = Position.y[eid] = Position.z[eid] = 0
    Rotation.x[eid] = Rotation.y[eid] = Rotation.z[eid] = 0
    Velocity.x[eid] = 0.5
    Velocity.y[eid] = Velocity.z[eid] = 0
  }
}

export type ILevel = InstanceType<typeof Level>
