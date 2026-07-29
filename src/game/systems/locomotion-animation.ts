import { AnimationTask as AnimationTaskDoc, LocomotionDirection, LocomotionSet } from '@inventory/schemas/model.schema'

import { BaseService, IServicesRegistry, KnownServices } from '@engine/services-registry'
import { AnimationProfile, AnimationTask, AnimatorLocked, Rotation, Velocity } from '@components'

// ponytail: stick jitter deadzone; a real thumbstick reads ~0.02 at rest. Under this the entity
// counts as idle regardless of what the physics broadcasts.
export const IDLE_SPEED = 0.05

// how much closer a rival direction must be before we switch to it. Digital input parks the stick
// exactly on a boundary (45° with only the four cardinals authored), where a hair of facing wobble
// flips the pick every frame — and each flip restarts a crossfade from zero weight, which reads as
// jitter. Half a boundary's width, so a deliberate turn still switches
const DIRECTION_HYSTERESIS = Math.PI / 8

// the same problem one axis over: a stick parked near a band's `above` threshold flips walk↔run
// every frame. Speed must clear the next band by this much before we climb, and drop this far
// below our own before we fall back
// kept small on purpose: bruno's run threshold is 2.5 and MAX_SPEED is 3, so a fat margin eats
// the whole run window and pins the character on walk
const BAND_HYSTERESIS = 0.1 // m/s

// what each entity is currently walking on, and the angle that chose it. Private to this system:
// nothing queries them, the readout is for the dev overlay
const CurrentDirection: LocomotionDirection[] = []
const CurrentBand: number[] = []
const CurrentAngle: number[] = []

// canonical angle for each direction, measured from the rig's forward (+Z), turning toward the
// rig's right (-X) as positive. Matches how we compute atan2(-localX, localZ) below
const DIRECTION_ANGLE: Record<LocomotionDirection, number> = {
  front: 0,
  frontRight: Math.PI / 4,
  right: Math.PI / 2,
  backRight: (3 * Math.PI) / 4,
  back: Math.PI,
  backLeft: -(3 * Math.PI) / 4,
  left: -Math.PI / 2,
  frontLeft: -Math.PI / 4,
}

/*
Turns movement into an animation: world velocity into the entity's own frame, direction and speed
into a locomotion clip. Reads the profile, never the mixer — starting the clip is
ThreeAnimatorSync's job.
*/
export class LocomotionAnimation extends BaseService {
  private world!: KnownServices['world']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
  }

  update() {
    const { query, hasComponent, addComponent } = this.world

    // no animator in the query: the player's mixer and an enemy's instance slot both consume the
    // task, and which one an entity has is not this system's business
    for (const eid of query([AnimationProfile, Velocity])) {
      const locomotion = AnimationProfile[eid].locomotion
      if (!locomotion) continue

      // the locked clip owns the animator (an action still finishing) — locomotion stays quiet
      // until the lock releases
      if (hasComponent(eid, AnimatorLocked)) continue

      // somebody else got there first and their task has not been consumed yet. A commanded clip
      // is only locked once its animator sees it, and an animator that runs after the commander
      // sees it a frame later — without this, locomotion overwrites the command in between
      if (hasComponent(eid, AnimationTask)) continue

      // written EVERY frame: rate scales with speed, so the animator must see the new task even
      // when the clip name is unchanged. Same-clip re-issue is idempotent in ThreeAnimatorSync
      // — it just updates timeScale without touching the playhead
      AnimationTask[eid] = { ...resolve(locomotion, eid), repeats: Infinity, carryPhase: true }
      addComponent(eid, AnimationTask)
    }
  }

  // for the dev overlay: which arm won and the angle that chose it, so a boundary flip is visible
  readout(eid: number): string {
    const direction = CurrentDirection[eid]
    if (!direction) return '—'
    return `${direction} ${((CurrentAngle[eid] * 180) / Math.PI).toFixed(0)}°  band ${CurrentBand[eid]}`
  }
}

const resolve = (locomotion: LocomotionSet, eid: number): AnimationTaskDoc => {
  const vx = Velocity.x[eid]
  const vz = Velocity.z[eid]
  const speed = Math.hypot(vx, vz)

  if (speed < IDLE_SPEED) return locomotion.idle

  // world → entity frame. Only yaw matters for a character on its feet
  const yaw = Rotation.y[eid]
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const localX = vx * cos - vz * sin
  const localZ = vx * sin + vz * cos

  // rig faces +Z; +right is -X. Angle measured from forward, growing toward the rig's right
  const angle = Math.atan2(-localX, localZ)

  // nearest direction the profile actually declares, with the one we are already playing given a
  // head start. front is required, so best is never null
  let best: LocomotionDirection = 'front'
  let bestDelta = Infinity
  for (const direction of Object.keys(DIRECTION_ANGLE) as LocomotionDirection[]) {
    if (!locomotion[direction]) continue
    let delta = Math.abs(shortestArc(angle - DIRECTION_ANGLE[direction]))
    if (direction === CurrentDirection[eid]) delta -= DIRECTION_HYSTERESIS
    if (delta < bestDelta) {
      best = direction
      bestDelta = delta
    }
  }
  CurrentDirection[eid] = best
  CurrentAngle[eid] = angle
  const bands = locomotion[best]!

  // highest band whose threshold this speed clears; bands are authored in ascending `above`. The
  // one we are on (and everything under it) gets its threshold lowered, everything above raised
  const current = CurrentBand[eid] ?? 0
  let index = 0
  for (let i = 0; i < bands.length; i++) {
    if (speed >= bands[i].above + (i <= current ? -BAND_HYSTERESIS : BAND_HYSTERESIS)) index = i
  }
  CurrentBand[eid] = index
  const band = bands[index]

  // playback tied to velocity: base = 1 loop per meter of ground travel. Assumes the clip is
  // authored so one loop covers 1 m of stride; doc `rate` is the per-clip correction for clips
  // whose actual stride differs. Foot-slip disappears once rate matches the clip's real stride
  return { ...band, rate: (band.rate ?? 1) * speed }
}

// signed distance around the unit circle in [-π, π] — needed because e.g. `angle=+170°` should
// count as closer to `back=+180°` than to `front=0°`, not further
const shortestArc = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

export type ILocomotionAnimation = InstanceType<typeof LocomotionAnimation>
