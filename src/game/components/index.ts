import * as THREE from 'three'
import { AnimationProfileState, AnimationTask as AnimationTaskDeclaration } from '@inventory/schemas/model.schema'
import { Vec3Row } from '@lib/type'

export type Vec3Component = { x: number[]; y: number[]; z: number[] }

export const Position: Vec3Component = { x: [], y: [], z: [] }
export const Velocity: Vec3Component = { x: [], y: [], z: [] }
export const Rotation: Vec3Component = { x: [], y: [], z: [] }

export const SceneObject: THREE.Object3D[] = []

// shared per model id — read-only config, never mutate an entity's copy in place
export const AnimationProfile: AnimationProfileState[] = []

// per entity, unlike AnimationProfile: a mixer holds playback state
export const ThreeAnimator: THREE.AnimationMixer[] = []

// what the model declares, plus the things only the caller decides
export type AnimationTaskState = AnimationTaskDeclaration & {
  repeats?: number // passes; Infinity = endless; absent = 1
  lock?: boolean // hold the animator until this clip finishes; refused with endless repeats
  carryPhase?: boolean // start where the outgoing clip left off instead of at 0; cyclic clips only
}

// a request to play a clip. Consumed by ThreeAnimatorSync, played or not
export const AnimationTask: AnimationTaskState[] = []

// presence is the lock. The value is the action whose completion releases it — set by the mixer
// path only; gpu-posed entities lock with no value and release themselves
export const AnimatorLocked: THREE.AnimationAction[] = []

// which slot of an InstancedSkin draws this entity. Its presence is also what marks the entity as
// gpu-posed rather than mixer-driven — the two animator syncs split on it
export const InstanceSlot: number[] = []

export const Health: number[] = []

export const NeedsSpawn = {}

export const NeedsDespawn = {}

export const NeedsDestroy = {}

export const IsPlayer = {}

export const IsSolid = {}

export const IsEnemy = {}

// killed, still playing the death clip out
export const Dying = {}

// the death clip finished: a pose on the ground that nothing simulates any more
export const IsCorpse = {}

export const writeVec3Row = (component: Vec3Component, eid: number, vr: Vec3Row): void => {
  component.x[eid] = vr[0]
  component.y[eid] = vr[1]
  component.z[eid] = vr[2]
}
