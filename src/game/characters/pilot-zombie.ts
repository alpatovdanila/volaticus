/*
 Pilot zombie locomotion — the one-band case: a single walk clip covers all movement, and with
 only `forward` declared every heading resolves to it, so there is no strafe/backpedal set to
 author. Attack/death/hit clips are not locomotion; whatever system plays them will write its
 own AnimationTask.

 nativeSpeed is a first-guess shamble pace, not yet eyeballed against the clip — tune it the
 first time this thing actually walks somewhere.
*/
import type { LocomotionAnimationProfileState } from '../engine/services/world/ecs/components'
import { STANDSTILL_SPEED } from '../engine/services/locomotion-animation'

export const PILOT_ZOMBIE_LOCOMOTION: LocomotionAnimationProfileState = {
  forward: [
    { clip: 'Zombie Idle', nativeSpeed: 0, fade: 0.3 },
    { above: STANDSTILL_SPEED, clip: 'Zombie Walk', nativeSpeed: 1.0, fade: 0.3 },
  ],
}
