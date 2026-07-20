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

export type AnimatorState = {
  mixer: THREE.AnimationMixer
  currentClip: string
}

export const ThreeAnimator: AnimatorState[] = []

export const NeedSpawn = {}

export const IsPlayer = {}

export const IsCamera = {}

/*
 What the entity's mixer should be playing this frame. `once` plays the clip a single time
 instead of looping and holds its last frame.
*/
export type AnimationTaskState = { clip: string; rate: number; fade: number; once: boolean }
export const AnimationTask: AnimationTaskState[] = []

export const Sprintable = {}

export type LockOnState = { x: number; z: number }
export const LockOn: LockOnState[] = []

// the entity is playing a scripted clip
export const PlaysAnimationClip = {}

// the entity's animation profile, from its inventory doc. Shared by reference across every
// entity built from the same doc — readonly by type
export const AnimationProfile: AnimationProfileState[] = []

export const writeVec3Row = (component: Vec3Component, eid: number, vr: Vec3Row): void => {
  component.x[eid] = vr[0]
  component.y[eid] = vr[1]
  component.z[eid] = vr[2]
}
