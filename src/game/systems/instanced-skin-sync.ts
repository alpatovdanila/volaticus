import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { AnimationTask, AnimatorLocked, InstanceSlot, IsCorpse, Position, Rotation } from '@components'
import { createInstancedSkin, InstancedSkin, PARKED } from '@lib/instanced-skin'

/*
Per-entity playback state. Private to this system for the same reason ThreeAnimatorSync keeps its
CurrentAction here: nothing queries it, so a registered component would cost a bitflag and buy
nothing.
*/
type Pool = { skin: InstancedSkin; free: number[] }

const Owner: Pool[] = []
const Clip: string[] = []
const Playhead: number[] = [] // seconds into the current clip
const Rate: number[] = []
const Loops: boolean[] = []

const PHASE_SPREAD = 2 // seconds of random head start handed to a fresh instance

const scratch = {
  matrix: new Matrix4(),
  position: new Vector3(),
  rotation: new Quaternion(),
  euler: new Euler(),
  scale: new Vector3(1, 1, 1),
}

/*
The ecs↔three boundary for gpu-posed entities — what ThreeSceneSync and ThreeAnimatorSync are for
mixer-driven ones, in one service because both halves write the same two instance buffers.

Owns the slot pool: an entity holds a slot for as long as it is on screen, alive or dead, and the
pool is the only thing that limits how many bodies can exist at once.
*/
export class InstancedSkinSync extends BaseService {
  private world!: KnownServices['world']
  private pools = new Map<string, Pool>()

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  // bakes the model's poses and puts its meshes in the scene. Idempotent per id
  register(id: string, root: Object3D, capacity: number): InstancedSkin {
    const existing = this.pools.get(id)
    if (existing) return existing.skin

    const skin = createInstancedSkin(root, capacity)
    // handed out from the end, so slot order follows spawn order rather than reversing it
    const free = Array.from({ length: capacity }, (_, slot) => capacity - 1 - slot)
    this.pools.set(id, { skin, free })

    for (const mesh of skin.meshes) this.world.scene.worldRoot.add(mesh)
    return skin
  }

  // false when the pool is dry — the caller decides what to evict, this service does not
  attach(eid: number, id: string): boolean {
    const pool = this.pools.get(id)
    if (!pool) throw new Error(`InstancedSkinSync: model '${id}' is not registered`)

    const slot = pool.free.pop()
    if (slot === undefined) return false

    this.world.addComponent(eid, InstanceSlot)
    InstanceSlot[eid] = slot
    Owner[eid] = pool
    Clip[eid] = ''
    Playhead[eid] = 0
    Rate[eid] = 1
    Loops[eid] = true
    return true
  }

  detach(eid: number): void {
    const pool = Owner[eid]
    if (!pool) return

    const slot = InstanceSlot[eid]
    PARKED.toArray(pool.skin.matrices.array, slot * 16)
    pool.skin.matrices.needsUpdate = true
    pool.free.push(slot)

    delete Owner[eid]
    this.world.removeComponent(eid, InstanceSlot)
  }

  // a one-shot clip that has reached its last frame. Always false while a clip loops
  finished(eid: number): boolean {
    const pool = Owner[eid]
    if (!pool || Loops[eid]) return false

    const range = pool.skin.clips.get(Clip[eid])
    return range ? Playhead[eid] * pool.skin.fps >= range.frames - 1 : true
  }

  update(dt: number) {
    this.consumeTasks()
    this.advance(dt)
  }

  private consumeTasks() {
    const { query, removeComponent, addComponent, hasComponent } = this.world

    for (const eid of query([InstanceSlot, AnimationTask])) {
      const task = AnimationTask[eid]
      removeComponent(eid, AnimationTask) // consumed whether or not it plays

      // the lock means the running clip owns this instance — a walk cannot cut a death short
      if (hasComponent(eid, AnimatorLocked)) continue

      const skin = Owner[eid]?.skin
      if (!skin) continue
      if (!skin.clips.has(task.clip)) {
        console.warn(`InstancedSkinSync: entity ${eid} has no baked clip '${task.clip}'`)
        continue
      }

      // rate is re-read every frame — locomotion scales it with speed — but the playhead only
      // restarts when the clip itself changes. There is no crossfade: instances cut
      Rate[eid] = task.rate ?? 1
      Loops[eid] = !Number.isFinite(task.repeats ?? 1)
      if (task.clip !== Clip[eid]) {
        Clip[eid] = task.clip
        // a loop starts somewhere random in its cycle rather than at frame 0: a crowd that all
        // began together marches in lockstep, which reads as one animation instead of many. A
        // one-shot still starts at the top — a death that began halfway through is nonsense
        Playhead[eid] = Loops[eid] ? Math.random() * PHASE_SPREAD : 0
      }

      // ponytail: whoever locks is expected to unlock — nothing here releases it, because the one
      // locker today (death) never wants it back. Revisit with the second one
      if (task.lock && !Loops[eid]) addComponent(eid, AnimatorLocked)
      else if (task.lock) console.warn(`InstancedSkinSync: refusing to lock entity ${eid} on endless clip '${task.clip}'`)
    }
  }

  private advance(dt: number) {
    const { query, hasComponent } = this.world
    const touched = new Set<InstancedSkin>()

    for (const eid of query([InstanceSlot, Position, Rotation])) {
      const skin = Owner[eid]?.skin
      // a corpse wrote its final row and its last matrix when it froze, and neither can change
      if (!skin || hasComponent(eid, IsCorpse)) continue

      const slot = InstanceSlot[eid]
      touched.add(skin)

      scratch.position.set(Position.x[eid], Position.y[eid], Position.z[eid])
      scratch.rotation.setFromEuler(scratch.euler.set(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid]))
      scratch.matrix.compose(scratch.position, scratch.rotation, scratch.scale)
      scratch.matrix.toArray(skin.matrices.array, slot * 16)

      const range = skin.clips.get(Clip[eid])
      if (!range) continue

      Playhead[eid] += dt * Rate[eid]
      const frame = Playhead[eid] * skin.fps
      const offset = Loops[eid] ? modulo(frame, range.frames) : Math.min(frame, range.frames - 1)
      skin.frames.setX(slot, range.row + Math.floor(offset))
    }

    for (const skin of touched) {
      skin.matrices.needsUpdate = true
      skin.frames.needsUpdate = true
    }
  }
}

// js % keeps the sign of the dividend, which would run a clip backwards off the front of its range
const modulo = (value: number, of: number) => ((value % of) + of) % of

export type IInstancedSkinSync = InstanceType<typeof InstancedSkinSync>
