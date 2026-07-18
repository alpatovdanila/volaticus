import * as THREE from 'three'
import { Vec3Row } from '../../../../lib/type'
import type { InventoryEntityDeclaration as InventoryEntityDeclarationType } from '../../../../../shared/type'

export type Vec3Component = { x: number[]; y: number[]; z: number[] }

export const Position: Vec3Component = { x: [], y: [], z: [] }
export const Velocity = { x: [], y: [], z: [] }
export const Rotation = { x: [], y: [], z: [] }

export const ThreeObject: THREE.Object3D[] = []

export const InventoryEntityDeclaration: InventoryEntityDeclarationType[] = []

export const NeedSpawn = {}

export const IsPlayer = {}

export const writeVec3Row = (component: Vec3Component, eid: number, vr: Vec3Row): void => {
  component.x[eid] = vr[0]
  component.y[eid] = vr[1]
  component.z[eid] = vr[2]
}
