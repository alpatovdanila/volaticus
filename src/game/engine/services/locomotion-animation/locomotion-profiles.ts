/*
 Per-character bindings from a movement state to the clip that depicts it, with the playback
 rate and blend duration tuned by eye against those specific clips. A rate means nothing
 without the clip it belongs to, so they live together.

 This is game data, not asset data: the GLB supplies clips, and which one counts as "the walk"
 is a decision made here.
*/
import { LocomotionAnimationProfileState } from '../world/ecs/components'

export const BRUNO_LOCOMOTION: LocomotionAnimationProfileState = {
  free: {
    idle: { clip: 'Rifle Idle', rate: 1, fade: 0.3 },
    walk: { clip: 'Rifle Walk', rate: 1.487, fade: 0.3 },
    run: { clip: 'Rifle Run', rate: 1.296, fade: 0.3 },
    sprint: { clip: 'Rifle Sprint', rate: 1.216, fade: 0.3 },
  },
  locked: {
    walk: {
      forward: { clip: 'Rifle Walk', rate: 1.487, fade: 0.3 },
      back: { clip: 'Backwards Rifle Walk', rate: 0.984, fade: 0.3 },
      left: { clip: 'Walk Rifle Left', rate: 0.833, fade: 0.3 },
      right: { clip: 'Walk Rifle Right', rate: 0.806, fade: 0.3 },
    },
    run: {
      forward: { clip: 'Rifle Run', rate: 1.296, fade: 0.3 },
      back: { clip: 'Backwards Rifle Run', rate: 1.371, fade: 0.3 },
      left: { clip: 'Run Rifle Left', rate: 1.123, fade: 0.3 },
      right: { clip: 'Run Rifle Right', rate: 0.932, fade: 0.3 },
    },
  },
}
