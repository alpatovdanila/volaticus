import { query } from 'bitecs'

import { IsPlayer, Rotation, Velocity } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

const WALK_SPEED = 2
const RUN_SPEED = 6

// stick magnitude above which a push counts as a run
const RUN_AT = 0.7

/*
 Turns stick input into velocity and facing for whoever is tagged playable. It writes
 components only — nothing here touches three.js.
*/
export class PlayerControl extends BaseService {
  private input!: KnownServices['input']
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.input = registry.get('input')
    this.world = registry.get('world')
  }

  update() {
    const { x, z } = this.input.getMove()
    const magnitude = Math.hypot(x, z)

    for (const eid of query(this.world.ecs, [IsPlayer, Velocity, Rotation])) {
      if (magnitude === 0) {
        Velocity.x[eid] = 0
        Velocity.z[eid] = 0
        continue
      }

      const speed = magnitude > RUN_AT ? RUN_SPEED : WALK_SPEED
      const dirX = x / magnitude
      const dirZ = z / magnitude

      Velocity.x[eid] = dirX * speed
      Velocity.z[eid] = dirZ * speed
      Rotation.y[eid] = Math.atan2(dirX, dirZ) // face where we are going
    }
  }
}

export type IPlayerControl = InstanceType<typeof PlayerControl>
