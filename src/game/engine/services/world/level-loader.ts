import * as THREE from 'three'
import { Color, Scene } from 'three'
import { addEntity, addComponent, type World } from 'bitecs'

import { Position, Rotation, ThreeNode, NeedSpawn, writeVec3Row, IsPlayer, InventoryEntity } from './ecs/components'
import { Vec3Row } from '../../../lib/type'
import { KnownServices } from '../../services-registry'

type Position = { position: Vec3Row }
type Rotation = { rotation: Vec3Row }

type HemisphereLight = {
  lightOptions: {
    skyColor: string
    groundColor: string
    intensity: number
  }
}

type DirectionalLight = {
  lightOptions: {
    color: '#ffffff'
    intensity: 2.5
  }
}

type MeshOptions = {
  mesh: {
    geometry: { type: 'plane'; width: number; height: number; tiles: number }
    inventoryMaterial: string
  }
}

type Mesh = { type: 'mesh' } & Position & Rotation & MeshOptions

type Light = { type: 'light' } & Position & Rotation & (DirectionalLight | HemisphereLight)

type InventoryEntity = { type: 'inventoryEntity'; inventoryEntity: string } & Position & Rotation

type Player = InventoryEntity & { isPlayer: boolean }

type SceneObject = Mesh | Light | InventoryEntity | Player

const isPlayer = (e: InventoryEntity | Player): e is Player => {
  return 'isPlayer' in e && e.isPlayer
}

export interface LevelDeclaration {
  scene: {
    camera: {
      initialPosition: Vec3Row
      initialRotation: Vec3Row
      initialOptions: {
        fov: number
        aspect: number
        far: number
        near: number
      }
    }
    background: string
    objects: SceneObject[]
  }
}

export class LevelLoader {
  constructor(
    private declaration: LevelDeclaration,
    private inventorySystem: KnownServices['inventory'],
  ) {}

  async loadAndBuild(escWorld: World) {
    const declaration = this.declaration

    const allMaterials = declaration.scene.objects.flatMap((o) => (o.type === 'mesh' ? [o.mesh.inventoryMaterial] : []))
    const allInventoryEntities = declaration.scene.objects.flatMap((o) =>
      o.type === 'inventoryEntity' ? [o.inventoryEntity] : [],
    )

    await Promise.all([
      ...allMaterials.map((id) => this.inventorySystem.load('material', id)),
      ...allInventoryEntities.map((id) => this.inventorySystem.load('entity', id)),
    ])

    for (const obj of this.declaration.scene.objects) {
      // todo: move out of class
      if (obj.type === 'mesh') this.ecsCommitMesh(escWorld, obj)
      if (obj.type === 'light') this.ecsCommitLight(escWorld, obj)
      if (obj.type === 'inventoryEntity') this.ecsCommitInventoryEntity(escWorld, obj)
    }

    return {
      scene: this.buildScene(declaration),
      camera: this.buildCamera(declaration),
    }
  }

  buildCamera(declaration: LevelDeclaration) {
    const {
      initialPosition,
      initialOptions: { fov, aspect, near, far },
      initialRotation,
    } = declaration.scene.camera

    const camera = new THREE.PerspectiveCamera(fov, aspect, near, far)
    camera.position.set(...initialPosition)
    camera.rotation.set(...initialRotation)

    return camera
  }

  buildScene(declaration: LevelDeclaration) {
    const scene = new Scene()
    scene.background = new Color(declaration.scene.background)
    return scene
  }

  ecsCommitMesh(world: World, obj: Mesh) {
    const geometry = new THREE.PlaneGeometry(obj.mesh.geometry.width, obj.mesh.geometry.height)
    const material = this.inventorySystem.get('material', obj.mesh.inventoryMaterial)
    const mesh = new THREE.Mesh(geometry, material)

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, ThreeNode)
    addComponent(world, eid, NeedSpawn)

    ThreeNode[eid] = mesh
    writeVec3Row(Position, eid, obj.position)
    writeVec3Row(Rotation, eid, obj.rotation)
  }

  ecsCommitLight(world: World, obj: Light) {
    // the declared hemisphere/directional options are ignored — always a PointLight
    const light = new THREE.PointLight()
    const eid = addEntity(world)

    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, ThreeNode)
    addComponent(world, eid, NeedSpawn)

    ThreeNode[eid] = light
    writeVec3Row(Position, eid, obj.position)
    writeVec3Row(Rotation, eid, obj.rotation)
  }

  ecsCommitInventoryEntity(world: World, obj: InventoryEntity | Player) {
    const inventoryEntity = this.inventorySystem.get('entity', obj.inventoryEntity)
    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, InventoryEntity)

    if (isPlayer(obj)) addComponent(world, eid, IsPlayer)

    InventoryEntity[eid] = inventoryEntity
    writeVec3Row(Position, eid, obj.position)
    writeVec3Row(Rotation, eid, obj.rotation)
  }
}
