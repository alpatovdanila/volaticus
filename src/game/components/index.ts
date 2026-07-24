import * as THREE from 'three'
import { Vec3Row } from '@lib/type'

export type Vec3Component = { x: number[]; y: number[]; z: number[] }

export const Position: Vec3Component = { x: [], y: [], z: [] }
export const Velocity: Vec3Component = { x: [], y: [], z: [] }
export const Rotation: Vec3Component = { x: [], y: [], z: [] }

export const SceneObject: THREE.Object3D[] = []

export const NeedsSpawn = {}

export const NeedsDespawn = {}

export const NeedsDestroy = {}

export const writeVec3Row = (component: Vec3Component, eid: number, vr: Vec3Row): void => {
  component.x[eid] = vr[0]
  component.y[eid] = vr[1]
  component.z[eid] = vr[2]
}
