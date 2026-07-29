import { Vector3 } from 'three'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { IsPlayer, Position, Rotation, Velocity } from '@components'

const MAX_SPEED = 3 // m/s at full stick
const TURN_SPEED = 8 // radians/sec
const BUTTON_A = 0 // standard-mapping A: toggles facing lock — held heading exercises strafe clips

/*
Turns the left stick into the player's velocity and facing, and nothing else. Which clip depicts
the resulting walk, strafe or backpedal is LocomotionAnimation's problem.

Deflection maps straight onto velocity, so speed is whatever the stick asks for this frame — no
wind-up, no coasting. Facing is rate-limited rather than snapped, deliberately: the turn is what
makes the strafe and backward clips reachable at all.

Facing lock (A): freezes the stick-follows-facing coupling. While locked, the player faces the
mouse cursor's projection onto the player's ground plane — a twin-stick-ish aim that lets you
strafe and backpedal deliberately.
*/
export class PlayerControls extends BaseService {
  private world!: KnownServices['world']
  private input!: KnownServices['input']
  private facingLocked = false
  // reused per-frame allocs for the mouse→ground raycast
  private aimNdc = new Vector3()
  private aimDir = new Vector3()

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
    this.input = registry.get('input')
  }

  update(dt: number) {
    const { query, camera } = this.world
    const { x, z } = this.input.getMove()
    const magnitude = Math.hypot(x, z)
    if (this.input.wasPressed(BUTTON_A)) this.facingLocked = !this.facingLocked

    for (const eid of query([IsPlayer, Position, Velocity, Rotation])) {
      Velocity.x[eid] = x * MAX_SPEED
      Velocity.z[eid] = z * MAX_SPEED

      const target = this.facingLocked ? aimTarget(this.input, camera, eid, this.aimNdc, this.aimDir) : stickTarget(x, z, magnitude, eid)
      if (target === null) continue

      Rotation.y[eid] = turnToward(Rotation.y[eid], target, TURN_SPEED * dt)
    }
  }
}

// stick heading: at rest, hold the current facing rather than whipping back to zero
const stickTarget = (x: number, z: number, magnitude: number, eid: number): number =>
  magnitude > 0 ? Math.atan2(x, z) : Rotation.y[eid]

/*
Mouse aim: unproject the cursor to a ray from the camera and intersect the player's ground plane
(y = player.y). Returns null if the ray runs parallel to the plane or points away — in that edge
case the caller just leaves facing where it is.
*/
const aimTarget = (
  input: KnownServices['input'],
  camera: KnownServices['world']['camera'],
  eid: number,
  ndc: Vector3,
  dir: Vector3,
): number | null => {
  const { x: nx, y: ny } = input.getMouseNdc()
  ndc.set(nx, ny, 0.5).unproject(camera)
  dir.copy(ndc).sub(camera.position).normalize()
  const py = Position.y[eid]
  const denom = dir.y
  if (Math.abs(denom) < 1e-6) return null // ray parallel to ground plane
  const t = (py - camera.position.y) / denom
  if (t <= 0) return null // aim point is behind the camera
  const hx = camera.position.x + dir.x * t
  const hz = camera.position.z + dir.z * t
  return Math.atan2(hx - Position.x[eid], hz - Position.z[eid])
}

// short way around: a raw difference sends a +170° -> -170° turn nearly the whole way round
const turnToward = (current: number, target: number, maxStep: number): number => {
  const shortest = Math.atan2(Math.sin(target - current), Math.cos(target - current))
  return Math.abs(shortest) <= maxStep ? target : current + Math.sign(shortest) * maxStep
}

export type IPlayerControls = InstanceType<typeof PlayerControls>
