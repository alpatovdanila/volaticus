import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { Dying, IsCorpse, IsEnemy, IsPlayer, Position, Rotation, Velocity } from '@components'
import { turnToward } from './player-controls'

const SPEED = 0.47 // m/s — a shamble; the walk clip's rate follows it, so they animate slower too
const SEPARATION = 0.8 // m of personal space, and therefore the grid's cell size
const SEPARATION_WEIGHT = 1.6 // how hard a neighbour pushes relative to the pull of the player
const TURN_SPEED = 6 // radians/sec

/*
Every enemy walks at the player and refuses to stand where another one already is. That is the
whole brain — no pathing, no states, no attack range.

Separation is what stops a horde collapsing into one silhouette, and it is the only part with a
cost that grows with the crowd. A uniform grid keeps it linear: cells are exactly one separation
radius wide, so the 3×3 block around an enemy contains every neighbour that could possibly be
pushing it, and nothing else is looked at.
*/
export class EnemySteering extends BaseService {
  private world!: KnownServices['world']

  // ponytail: a Map of cell → eids, rebuilt every frame. A head/next pair of typed arrays would
  // allocate nothing; swap it in when the allocation actually shows up in a profile
  private grid = new Map<number, number[]>()

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update(dt: number) {
    const { query, hasComponent } = this.world

    const [player] = query([IsPlayer, Position])
    if (player === undefined) return

    const playerX = Position.x[player]
    const playerZ = Position.z[player]

    const walking: number[] = []
    for (const eid of query([IsEnemy, Position, Velocity, Rotation])) {
      // the dead neither chase nor shove
      if (!hasComponent(eid, Dying) && !hasComponent(eid, IsCorpse)) walking.push(eid)
    }

    this.grid.clear()
    for (const eid of walking) {
      const key = cell(Position.x[eid], Position.z[eid])
      const bucket = this.grid.get(key)
      if (bucket) bucket.push(eid)
      else this.grid.set(key, [eid])
    }

    for (const eid of walking) {
      const x = Position.x[eid]
      const z = Position.z[eid]

      const toPlayer = Math.hypot(playerX - x, playerZ - z) || 1
      let dx = (playerX - x) / toPlayer
      let dz = (playerZ - z) / toPlayer

      const cx = Math.floor(x / SEPARATION)
      const cz = Math.floor(z / SEPARATION)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = this.grid.get(key(cx + ox, cz + oz))
          if (!bucket) continue

          for (const other of bucket) {
            if (other === eid) continue

            const awayX = x - Position.x[other]
            const awayZ = z - Position.z[other]
            const distance = Math.hypot(awayX, awayZ)
            if (distance === 0 || distance > SEPARATION) continue

            // linear falloff, normalised by distance: a full shove when touching, nothing at
            // arm's length
            const push = (((SEPARATION - distance) / SEPARATION) * SEPARATION_WEIGHT) / distance
            dx += awayX * push
            dz += awayZ * push
          }
        }
      }

      const length = Math.hypot(dx, dz) || 1
      Velocity.x[eid] = (dx / length) * SPEED
      Velocity.z[eid] = (dz / length) * SPEED
      // rate-limited rather than snapped, or a shove from behind spins the model on the spot
      Rotation.y[eid] = turnToward(Rotation.y[eid], Math.atan2(dx, dz), TURN_SPEED * dt)
    }
  }
}

// cell coordinates packed into one number, biased so negative arena coordinates stay positive.
// ±512 cells is a 800 m arena at this cell size — far past anything we will play on
const key = (cx: number, cz: number) => (cx + 512) * 1024 + (cz + 512)

const cell = (x: number, z: number) => key(Math.floor(x / SEPARATION), Math.floor(z / SEPARATION))

export type IEnemySteering = InstanceType<typeof EnemySteering>
