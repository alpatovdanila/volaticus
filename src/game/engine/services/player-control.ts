import { query } from 'bitecs'

import { IsPlayer, Rotation, Velocity } from './world/ecs/components'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

const WALK_SPEED = 2
const RUN_SPEED = 6

// stick magnitude above which a push counts as a run
const RUN_AT = 0.7

// radians per second the character swings toward the stick direction. Snapping instantly
// reads as a teleport on a direction change; at 8 a full about-face costs ~0.4s, which is
// felt without costing control. Velocity still follows the stick immediately — only the
// facing lags, so the character briefly slides while coming about.
const TURN_SPEED = 8

/*
 Step an angle toward a target by at most maxStep, the SHORT way around. A raw
 (target - current) would send a turn from +170° to -170° the long way — 340° of spin to
 cover 20° — so the delta is re-wrapped into [-PI, PI] first.
*/
const turnToward = (current: number, target: number, maxStep: number): number => {
  const difference = target - current
  const shortest = Math.atan2(Math.sin(difference), Math.cos(difference))
  if (Math.abs(shortest) <= maxStep) return target // close enough; land exactly, don't jitter
  return current + Math.sign(shortest) * maxStep
}

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

  update(dt: number) {
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
      // turn toward where we are going, rather than snapping to it
      Rotation.y[eid] = turnToward(Rotation.y[eid], Math.atan2(dirX, dirZ), TURN_SPEED * dt)
    }
  }
}

export type IPlayerControl = InstanceType<typeof PlayerControl>
