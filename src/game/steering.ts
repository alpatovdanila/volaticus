// Steering behaviours — generic, agent-agnostic movement helpers shared by ANY enemy
// manager (the zombie horde today, ranged/flying types later). They operate on bare XZ
// positions, so nothing here knows what an "enemy" is; a manager maps its agents to
// positions, calls a behaviour, and applies the returned offsets however it likes.

export interface Vec2 {
  x: number
  z: number
}

// SEPARATION — boids' first rule, the cheap fix for "enemies walk through each other".
// Every agent is pushed away from neighbours within `radius`, the shove growing as they
// crowd closer (linear falloff, so it's soft at the edge and firm at the centre). Returns
// one offset DIRECTION+weight per input position (index-aligned); the caller scales by a
// strength × dt and adds it to the agent's position. No alignment/cohesion — pure
// anti-overlap, which is all that's needed to stop bodies interpenetrating.
//
// Cost is O(n²) but symmetric (each pair visited once), so ~n²/2 — trivial for the tens of
// enemies a wave holds. For hundreds, bucket the agents into a spatial grid and only test
// neighbours in adjacent cells; the per-pair math below is unchanged.
export function separationOffsets(positions: Vec2[], radius: number): Vec2[] {
  const out: Vec2[] = positions.map(() => ({ x: 0, z: 0 }))
  const r2 = radius * radius
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const ax = positions[i].x - positions[j].x
      const az = positions[i].z - positions[j].z
      const d2 = ax * ax + az * az
      if (d2 >= r2 || d2 < 1e-8) continue
      const d = Math.sqrt(d2)
      const w = (radius - d) / radius / d // normalise the direction (÷d) × linear falloff
      out[i].x += ax * w
      out[i].z += az * w
      out[j].x -= ax * w // symmetric: j is pushed the opposite way
      out[j].z -= az * w
    }
  }
  return out
}
