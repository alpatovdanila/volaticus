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

export const BRUNO_LOCOMOTION: LocomotionAnimationProfileState = {
  forward: [
    { clip: 'Rifle Idle', nativeSpeed: 0, fade: 0.1 },
    { above: 0.05, clip: 'Rifle Walk', nativeSpeed: 1.0508, fade: 0.1 },
    { above: 3.0, clip: 'Rifle Run', nativeSpeed: 3.6169, fade: 0.1 },
    { above: 5.8, clip: 'Rifle Sprint', nativeSpeed: 5.9108, fade: 0.1 },
  ],
  back: [
    { clip: 'Backwards Rifle Walk', nativeSpeed: 0.8733, fade: 0.1 },
    { above: 1.7, clip: 'Backwards Rifle Run', nativeSpeed: 1.8805, fade: 0.1 },
  ],
  left: [
    { clip: 'Walk Rifle Left', nativeSpeed: 1.5006, fade: 0.1 },
    { above: 2.4, clip: 'Run Rifle Left', nativeSpeed: 3.3393, fade: 0.1 },
  ],
  right: [
    { clip: 'Walk Rifle Right', nativeSpeed: 1.5509, fade: 0.1 },
    { above: 2.4, clip: 'Run Rifle Right', nativeSpeed: 4.0236, fade: 0.1 },
  ],
}
