import * as THREE from 'three'
import { Vec3Row } from '../../../../lib/type'
import type { InventoryEntityDeclaration as InventoryEntityDocType } from '../../../../../shared/inventory-schema'
import { addComponent } from 'bitecs'

export type Vec3Component = { x: number[]; y: number[]; z: number[] }

export const Position: Vec3Component = { x: [], y: [], z: [] }
export const Velocity: Vec3Component = { x: [], y: [], z: [] }
export const Rotation: Vec3Component = { x: [], y: [], z: [] }

export const ThreeObject: THREE.Object3D[] = []

export const InventoryEntityDoc: InventoryEntityDocType[] = []

export type AnimatorState = {
  mixer: THREE.AnimationMixer
  currentClip: string
}

export const ThreeAnimator: AnimatorState[] = []

export const NeedSpawn = {}

export const IsPlayer = {}

export const IsCamera = {}

export type AnimationTaskState = { clip: string; rate: number; fade: number }
export const AnimationTask: AnimationTaskState[] = []

export const Sprintable = {}

export type LockOnState = { x: number; z: number }
export const LockOn: LockOnState[] = []

export type LocomotionDirection = 'forward' | 'back' | 'left' | 'right'

/*
 One clip and the speed band it covers. `above` is the band's lower bound in m/s: a direction's
 bands are scanned from the end, so the last bound the entity has passed wins, and the first
 band omits it to cover everything below.

 `nativeSpeed` is the ground speed the clip depicts at rate 1 — measured by eye once, per clip.
 Playback rate is speed / nativeSpeed, so retuning how fast a character moves cannot desync the
 feet from the floor. 0 means the clip depicts no travel (idle) and plays at rate 1.

 Everything here is readonly on purpose: a profile is SHARED BY REFERENCE by every entity of
 its archetype — an upgrade that mutated a band would retune the whole species, and every
 future spawn. Per-entity modifiers must multiply the RESULT (a stat component), never edit
 the table.
*/
export type LocomotionBand = {
  readonly above?: number
  readonly clip: string
  readonly nativeSpeed: number
  readonly fade: number
}

/*
 The directions a rig actually has clips for. A heading resolves to the NEAREST declared
 direction, so the shape scales with the rig rather than with the engine: declare `forward`
 alone and it plays for all movement, declare four and the usual quarter-split falls out
 without anyone naming a boundary. Only `forward` is required — it is what standing still uses.
*/
export type LocomotionAnimationProfileState = {
  readonly forward: readonly LocomotionBand[]
  readonly back?: readonly LocomotionBand[]
  readonly left?: readonly LocomotionBand[]
  readonly right?: readonly LocomotionBand[]
}
export const LocomotionAnimationProfile: LocomotionAnimationProfileState[] = []

export const writeVec3Row = (component: Vec3Component, eid: number, vr: Vec3Row): void => {
  component.x[eid] = vr[0]
  component.y[eid] = vr[1]
  component.z[eid] = vr[2]
}
