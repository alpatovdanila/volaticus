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

export type LocomotionGait = 'idle' | 'walk' | 'run' | 'sprint'
export type LocomotionDirection = 'forward' | 'back' | 'left' | 'right'
export type LocomotionState = { gait: LocomotionGait; direction: LocomotionDirection }
export const Locomotion: LocomotionState[] = []

export type LocomotionClip = { clip: string; rate: number; fade: number }
export type LocomotionAnimationProfileState = {
  free: Record<LocomotionGait, LocomotionClip>
  locked: Record<'walk' | 'run', Record<LocomotionDirection, LocomotionClip>>
}
export const LocomotionAnimationProfile: LocomotionAnimationProfileState[] = []

export const writeVec3Row = (component: Vec3Component, eid: number, vr: Vec3Row): void => {
  component.x[eid] = vr[0]
  component.y[eid] = vr[1]
  component.z[eid] = vr[2]
}
