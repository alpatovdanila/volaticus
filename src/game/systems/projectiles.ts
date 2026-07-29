import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import {
  Dismember,
  Health,
  NeedsDespawn,
  NeedsDestroy,
  Position,
  Projectile,
  Rotation,
  Velocity,
} from '@components'
import { nearestEnemy } from '@lib/nearest-enemy'

// metres — one enemy's body, tested against the projectile's centre.
// ponytail: a point test at frame positions, not a swept one. A projectile crossing more than
// 2×HIT_RADIUS in a frame can step over a body; at 22 m/s that is 0.37 m against a 0.9 m window,
// so the headroom runs out somewhere past 50 m/s. Sweep the segment if speeds ever get there
const HIT_RADIUS = 0.45

/*
What a bullet does after it leaves the barrel: hit something, bounce off it, or run out of range.

Flight is not here — a projectile is Position + Velocity, and Movement already integrates those.
This runs straight after it, so every test is against the positions of this frame rather than the
last one.
*/
export class Projectiles extends BaseService {
  private world!: KnownServices['world']
  private skins!: KnownServices['instancedSkinSync']
  private limbs!: KnownServices['limbs']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
    this.skins = registry.get('instancedSkinSync')
    this.limbs = registry.get('limbs')
  }

  update(dt: number) {
    const { query } = this.world

    for (const eid of query([Projectile, Position, Velocity])) {
      const projectile = Projectile[eid]
      const speed = Math.hypot(Velocity.x[eid], Velocity.z[eid])
      projectile.travelled += speed * dt

      // the enemy it just came off is excluded: the projectile is still standing inside that body
      const hit = nearestEnemy(this.world, Position.x[eid], Position.z[eid], HIT_RADIUS, projectile.lastTarget)
      if (hit === -1) {
        if (projectile.travelled > projectile.range) this.despawn(eid)
        continue
      }

      Health[hit] -= projectile.damage
      // read before any ricochet turns it: the limb should carry on the way the shot was going
      this.maybeDismember(hit, projectile.dismemberChance, Velocity.x[eid], Velocity.z[eid])

      if (projectile.bounces <= 0) {
        this.despawn(eid)
        continue
      }

      // two deep, not one: excluding only the enemy just hit lets a bounce come straight back, and
      // two adjacent zombies would trade the same bullet for its whole bounce budget
      const next = nearestEnemy(
        this.world,
        Position.x[hit],
        Position.z[hit],
        projectile.bounceRange,
        hit,
        projectile.lastTarget,
      )
      if (next === -1) {
        this.despawn(eid)
        continue
      }

      projectile.bounces--
      projectile.lastTarget = hit

      const angle = Math.atan2(Position.x[next] - Position.x[eid], Position.z[next] - Position.z[eid])
      Velocity.x[eid] = Math.sin(angle) * speed
      Velocity.z[eid] = Math.cos(angle) * speed
      Rotation.y[eid] = angle // the streak turns with it
    }
  }

  /*
  Rolled on every hit, killing blow included: a zombie that loses a hand as it drops looks better
  than one that is spared because the shot happened to finish it.
  */
  private maybeDismember(eid: number, chance: number, dirX: number, dirZ: number) {
    const table = Dismember[eid]
    if (!table || Math.random() >= chance) return

    const severed = this.skins.sever(eid, pickPart(table))
    if (severed) this.limbs.throw(severed, dirX, dirZ)
  }

  private despawn(eid: number) {
    // NeedsDespawn takes the mesh out of the scene, NeedsDestroy takes the entity out of the ecs —
    // both are read later this frame, by ThreeSceneSync and Destroy
    this.world.addComponent(eid, NeedsDespawn, NeedsDestroy)
  }
}

// weighted pick. The table is tiny — two hands — so summing it every time costs nothing
const pickPart = (table: Record<string, { weight: number }>): string => {
  const parts = Object.entries(table)

  let total = 0
  for (const [, part] of parts) total += part.weight

  let roll = Math.random() * total
  for (const [name, part] of parts) {
    roll -= part.weight
    if (roll <= 0) return name
  }
  return parts[parts.length - 1][0]
}

export type IProjectiles = InstanceType<typeof Projectiles>
