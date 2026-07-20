import { query } from 'bitecs'

import { IsCamera, IsPlayer, Position, Rotation } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

const HEIGHT = 7
const PITCH = -Math.PI / 4 // 60deg down from horizontal

// at this pitch the screen centre lands HEIGHT/tan(pitch) ahead, so sitting that far back is
// what puts the player in the middle
const BACK = HEIGHT / Math.tan(-PITCH)

// how quickly the camera closes the remaining gap, per second
const FOLLOW = 4

/*
 Moves the camera entity to follow the player: a fixed top-down orientation and an X/Z position
 that closes on the target smoothly. Writes Position/Rotation components only — ThreeSceneSync
 puts them on the three camera, same as any other entity.
*/
export class CameraControl extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    const ecs = this.world.ecs
    const camera = query(ecs, [IsCamera, Position, Rotation])[0]
    const player = query(ecs, [IsPlayer, Position])[0]
    if (camera === undefined || player === undefined) return

    const t = 1 - Math.exp(-FOLLOW * dt) // frame-rate independent smoothing
    const focusX = Position.x[camera] + (Position.x[player] - Position.x[camera]) * t
    const focusZ = Position.z[camera] - BACK + (Position.z[player] - (Position.z[camera] - BACK)) * t

    Position.x[camera] = focusX
    Position.y[camera] = HEIGHT
    Position.z[camera] = focusZ + BACK

    Rotation.x[camera] = PITCH
    Rotation.y[camera] = 0
    Rotation.z[camera] = 0
  }
}

export type ICameraControl = InstanceType<typeof CameraControl>
