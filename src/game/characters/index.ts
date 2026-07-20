/*
 What a body IS, keyed by the inventory entity it is built from — as opposed to who drives it,
 which is what IsPlayer and (later) an AI component answer. The same archetype driven by input
 or by a behaviour tree is the same character.

 Attached at spawn rather than lazily in an update loop, so an entity is complete the frame it
 exists. Entities absent from this table are not characters (props, scenery); they simply get
 no character components.
*/
import type { LocomotionAnimationProfileState } from '../engine/services/world/ecs/components'
import { BRUNO_LOCOMOTION } from './bruno'
import { PILOT_ZOMBIE_LOCOMOTION } from './pilot-zombie'

export type Character = {
  locomotion: LocomotionAnimationProfileState
}

// keyed by inventory entity id — characterFor(obj.inventoryEntity) at spawn
const CHARACTERS: Record<string, Character> = {
  bruno: { locomotion: BRUNO_LOCOMOTION },
  pilot_zombie: { locomotion: PILOT_ZOMBIE_LOCOMOTION },
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
  // flatMap over ?? [] instead of a cast: an explicitly-undefined direction key must yield
  // nothing, not an undefined element that crashes on .clip
  const bands = Object.values(profile).flatMap((direction) => direction ?? [])
  const missing = [...new Set(bands.map((b) => b.clip))].filter((c) => !available.has(c))
  if (missing.length) console.warn(`character '${id}': model has no clip(s): ${missing.join(', ')}`)
}
