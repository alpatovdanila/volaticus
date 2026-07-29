import { IWorld } from '@engine/world'
import { Dying, IsCorpse, IsEnemy, Position } from '@components'

/*
Closest living enemy to a point, or -1.

ponytail: a linear scan. At the pool's 400 enemies that is 400 distance checks per caller per
frame and it does not register; the uniform grid in enemy-steering is the upgrade when it does.
*/
export const nearestEnemy = (
  world: IWorld,
  x: number,
  z: number,
  within: number,
  exclude = -1,
  alsoExclude = -1,
): number => {
  const { query, hasComponent } = world

  let best = -1
  let bestDistance = within * within

  for (const eid of query([IsEnemy, Position])) {
    if (eid === exclude || eid === alsoExclude) continue
    if (hasComponent(eid, Dying) || hasComponent(eid, IsCorpse)) continue

    const dx = Position.x[eid] - x
    const dz = Position.z[eid] - z
    const distance = dx * dx + dz * dz // squared: nothing here needs the real number
    if (distance >= bestDistance) continue

    best = eid
    bestDistance = distance
  }

  return best
}
