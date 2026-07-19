/*
 What a body IS, keyed by the inventory entity it is built from — as opposed to who drives it,
 which is what IsPlayer and (later) an AI component answer. The same archetype driven by input
 or by a behaviour tree is the same character.

 Attached at spawn rather than lazily in an update loop, so an entity is complete the frame it
 exists. Entities absent from this table are not characters (props, scenery); they simply get
 no character components.
*/
import type { LocomotionAnimationProfileState, LocomotionBand } from '../engine/services/world/ecs/components'
import { BRUNO_LOCOMOTION } from './bruno'

export type Character = {
  locomotion: LocomotionAnimationProfileState
}

const CHARACTERS: Record<string, Character> = {
  bruno: { locomotion: BRUNO_LOCOMOTION },
}

export const characterFor = (inventoryEntityId: string): Character | undefined => CHARACTERS[inventoryEntityId]

/*
 A clip the profile names but the model never shipped would freeze the character silently, so
 the two are checked against each other at spawn — the one moment both are in hand. Per
 archetype, not once per process: a latch on the first entity ever spawned would leave every
 later one unchecked.
*/
export const warnMissingClips = (
  id: string,
  profile: LocomotionAnimationProfileState,
  clips: { name: string }[],
): void => {
  const available = new Set(clips.map((c) => c.name))
  const bands = Object.values(profile).flat() as LocomotionBand[]
  const missing = [...new Set(bands.map((b) => b.clip))].filter((c) => !available.has(c))
  if (missing.length) console.warn(`character '${id}': model has no clip(s): ${missing.join(', ')}`)
}
