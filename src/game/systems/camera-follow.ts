import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { IsPlayer, Position } from '@components'

// world-space offset from the player. Fixed frame (not rotating with the player) so a facing lock
// leaves the camera behind the character rather than orbiting with them — strafe clips stay
// visible from a stable angle
const OFFSET = { x: 0, y: 1.8, z: 4.5 }
const LOOK_HEIGHT = 1.2 // aim roughly at the player's chest, not the feet

/*
Places the world camera at a fixed offset from the player each frame and points it at them. No
smoothing — the player's own motion is smooth already, and lerped follow buys nothing at this
distance except lag.
*/
export class CameraFollow extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    const { query, camera } = this.world
    for (const eid of query([IsPlayer, Position])) {
      const px = Position.x[eid]
      const py = Position.y[eid]
      const pz = Position.z[eid]
      camera.position.set(px + OFFSET.x, py + OFFSET.y, pz + OFFSET.z)
      camera.lookAt(px, py + LOOK_HEIGHT, pz)
      return // one player
    }
  }
}

export type ICameraFollow = InstanceType<typeof CameraFollow>
