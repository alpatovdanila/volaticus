/*
 Bruno's locomotion clips, banded by ground speed and by which way he is travelling relative to
 his own facing. Aim-locked movement is not a separate mode here: while facing follows travel a
 heading is always ~0, so the `forward` bands are what plays. Holding an aim target is the only
 thing that makes the other three reachable.

 This is game data, not asset data: the GLB supplies clips, and which one counts as "the walk"
 — and how fast the walk it depicts actually is — are decisions made here.

 `nativeSpeed` was recovered from the playback rates these clips were originally hand-tuned to
 (speed / rate), so the character moves and animates exactly as it did before bands existed.
 Re-measure by eye if a clip is ever reimported.
*/
import type { LocomotionAnimationProfileState } from '../engine/services/world/ecs/components'
import { STANDSTILL_SPEED } from '../engine/services/locomotion-animation'

export const BRUNO_LOCOMOTION: LocomotionAnimationProfileState = {
  forward: [
    { clip: 'Rifle Idle', nativeSpeed: 0, fade: 0.4 },
    { above: STANDSTILL_SPEED, clip: 'Rifle Walk', nativeSpeed: 1.22, fade: 0.4 },
    { above: 2.5, clip: 'Rifle Run', nativeSpeed: 4.2, fade: 0.4 },
    { above: 5.8, clip: 'Rifle Sprint', nativeSpeed: 6.3, fade: 0.4 },
  ],
  back: [
    { clip: 'Backwards Rifle Walk', nativeSpeed: 1.6, fade: 0.4 },
    { above: 1.7, clip: 'Backwards Rifle Run', nativeSpeed: 4.2, fade: 0.4 },
  ],
  left: [
    { clip: 'Walk Rifle Left', nativeSpeed: 1.4, fade: 0.4 },
    { above: 2.4, clip: 'Run Rifle Left', nativeSpeed: 4.2, fade: 0.4 },
  ],
  right: [
    { clip: 'Walk Rifle Right', nativeSpeed: 1.4, fade: 0.1 },
    { above: 2.4, clip: 'Run Rifle Right', nativeSpeed: 4.2, fade: 0.4 },
  ],
}
