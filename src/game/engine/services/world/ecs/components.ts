import * as THREE from 'three'
import { Vec3Row } from '../../../../lib/type'
import type {
  AnimationProfileState,
  InventoryEntityDeclaration as InventoryEntityDocType,
} from '../../../../../shared/inventory-schema'

export type Vec3Component = { x: number[]; y: number[]; z: number[] }

export const Position: Vec3Component = { x: [], y: [], z: [] }
export const Velocity: Vec3Component = { x: [], y: [], z: [] }
export const Rotation: Vec3Component = { x: [], y: [], z: [] }

export const ThreeObject: THREE.Object3D[] = []

export const InventoryEntityDoc: InventoryEntityDocType[] = []

export type ThreeAnimatorState = {
  mixer: THREE.AnimationMixer
  // what is actually playing — the clip a switch crossfades away from
  currentClip: string
  // a commanded playback restarts its clip even when it is the one already playing
  restartPending: boolean
}

export const ThreeAnimator: ThreeAnimatorState[] = []

export const NeedSpawn = {}

export const IsPlayer = {}

export const IsCamera = {}

/**
 One playable clip with its tuning. Absent rate plays as authored, absent fade cuts straight
 to the clip. `repeats` bounds the playback: in AnimatorState absence means loop forever, in
 AnimatorTask absence means one pass — a task must end for the animator to come free.
*/
export type AnimatorClip = { clip: string; rate?: number; fade?: number; repeats?: number }

// what the animator is playing right now — open state, writable by anyone at any time
export const AnimatorState: AnimatorClip[] = []

// a commanded playback, waiting for the animator to take it
export const AnimatorTask: AnimatorClip[] = []

/**
 * the flag that indicates if any animation task is being played now. When tag is set, its is generally not recommended to write
 * AnimatorState directly, hovewer, that is by convention only
 */
export const IsAnimatorFree = {}

export const Sprintable = {}

export type LockOnState = { x: number; z: number }
export const LockOn: LockOnState[] = []

/**
 * the entity's animation profile, from its inventory doc. Shared by reference across every
 * entity built from the same doc — readonly by type
 */
export const AnimationProfile: AnimationProfileState[] = []

export const writeVec3Row = (component: Vec3Component, eid: number, vr: Vec3Row): void => {
  component.x[eid] = vr[0]
  component.y[eid] = vr[1]
  component.z[eid] = vr[2]
}
