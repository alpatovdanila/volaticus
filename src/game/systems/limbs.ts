import { Matrix4, Quaternion, Vector3 } from 'three'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { Limb, NeedsDestroy, Position, Velocity } from '@components'
import { createLimbInstance, LimbInstance, PARKED, SkinPart } from '@lib/instanced-skin'
import { Severed } from './instanced-skin-sync'

const LIMB_LIMIT = 60 // loose parts kept on the ground; the oldest goes when the next one lands
const CAPACITY = 80 // instance slots per part, a little above the limit so a throw never fails
const GRAVITY = -18 // m/s², heavier than real: a limb that hangs in the air reads as floaty
const LAUNCH_UP = 3 // m/s
const LAUNCH_OUT = 2.5 // m/s away from the body
const SPIN = 14 // radians/sec, at most
const GROUND = 0.1 // where a limb's own centre comes to rest

type Pool = { instance: LimbInstance; free: number[] }

const scratch = {
  matrix: new Matrix4(),
  pivot: new Matrix4(),
  position: new Vector3(),
  turn: new Quaternion(),
  scale: new Vector3(1, 1, 1),
}

/*
Severed parts, thrown and left lying about.

A loose hand is drawn by the same shader as the body it came off, from the same bone texture, with
its playhead frozen at the frame it was cut on — so it keeps the exact pose it was in and needs no
new geometry and no cpu skinning. What it gets of its own is a transform, which is what lets it
tumble away.

That transform pivots about the part rather than the body's origin: a hand is posed a metre off
the model origin, and spinning it about the origin would swing it in an arc instead of turning it
in place.

ponytail: no bounce, no friction, no collision with anything. It falls, it lands, it stops.
*/
export class Limbs extends BaseService {
  private world!: KnownServices['world']
  private pools = new Map<SkinPart, Pool>()
  private thrown: number[] = [] // oldest first

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  // dirX/dirZ is the direction the shot was travelling: the limb carries on the way it was hit
  throw(severed: Severed, dirX: number, dirZ: number) {
    const pool = this.poolFor(severed)
    const slot = pool.free.pop()
    if (slot === undefined) return // every slot is in the air; skip rather than steal one mid-flight

    const eid = this.world.addEntity(Position, Velocity, Limb)

    // starts exactly where the hand was: the body's transform applied to the part's own offset
    scratch.position.copy(severed.offset).applyMatrix4(severed.matrix)
    Position.x[eid] = scratch.position.x
    Position.y[eid] = scratch.position.y
    Position.z[eid] = scratch.position.z

    const length = Math.hypot(dirX, dirZ) || 1

    Velocity.x[eid] = (dirX / length) * LAUNCH_OUT
    Velocity.y[eid] = LAUNCH_UP
    Velocity.z[eid] = (dirZ / length) * LAUNCH_OUT

    Limb[eid] = {
      part: severed.part,
      slot,
      offset: severed.offset.clone(),
      rotation: new Quaternion().setFromRotationMatrix(severed.matrix),
      axis: new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      rate: (Math.random() * 0.6 + 0.4) * SPIN,
      settled: false,
    }

    pool.instance.frames.setX(slot, severed.row)
    pool.instance.frames.needsUpdate = true

    this.thrown.push(eid)
    while (this.thrown.length > LIMB_LIMIT) this.clear(this.thrown.shift()!)
  }

  update(dt: number) {
    const { query } = this.world
    const touched = new Set<LimbInstance>()

    for (const eid of query([Limb, Position, Velocity])) {
      const limb = Limb[eid]
      // a landed limb wrote its last matrix when it stopped, and nothing can move it again
      if (limb.settled) continue

      const pool = this.pools.get(limb.part)
      if (!pool) continue
      touched.add(pool.instance)

      Velocity.y[eid] += GRAVITY * dt
      scratch.turn.setFromAxisAngle(limb.axis, limb.rate * dt)
      limb.rotation.premultiply(scratch.turn)

      if (Position.y[eid] <= GROUND) {
        Position.y[eid] = GROUND
        Velocity.x[eid] = 0
        Velocity.y[eid] = 0
        Velocity.z[eid] = 0
        limb.settled = true
      }

      scratch.position.set(Position.x[eid], Position.y[eid], Position.z[eid])
      scratch.matrix.compose(scratch.position, limb.rotation, scratch.scale)
      scratch.pivot.makeTranslation(-limb.offset.x, -limb.offset.y, -limb.offset.z)
      scratch.matrix.multiply(scratch.pivot).toArray(pool.instance.matrices.array, limb.slot * 16)
    }

    for (const instance of touched) instance.matrices.needsUpdate = true
  }

  private poolFor(severed: Severed): Pool {
    const existing = this.pools.get(severed.part)
    if (existing) return existing

    const instance = createLimbInstance(severed.skin, severed.part, CAPACITY)
    this.world.scene.worldRoot.add(instance.mesh)

    const pool = {
      instance,
      free: Array.from({ length: CAPACITY }, (_, slot) => CAPACITY - 1 - slot),
    }
    this.pools.set(severed.part, pool)
    return pool
  }

  private clear(eid: number) {
    const limb = Limb[eid]
    const pool = this.pools.get(limb.part)
    if (pool) {
      PARKED.toArray(pool.instance.matrices.array, limb.slot * 16)
      pool.instance.matrices.needsUpdate = true
      pool.free.push(limb.slot)
    }
    this.world.addComponent(eid, NeedsDestroy)
  }
}

export type ILimbs = InstanceType<typeof Limbs>
