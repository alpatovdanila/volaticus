import * as THREE from 'three'
import { Color, Scene } from 'three'
import { addEntity, addComponent, type World } from 'bitecs'

import {
  Position,
  Rotation,
  ThreeObject,
  NeedSpawn,
  writeVec3Row,
  IsPlayer,
  InventoryEntityDeclaration,
} from './ecs/components'
import type { LevelDeclaration, MeshObject, LightObject, InventoryEntityObject } from './level-schema'
import { KnownServices } from '../../services-registry'

export class LevelLoader {
  constructor(
    private declaration: LevelDeclaration,
    private inventorySystem: KnownServices['inventory'],
  ) {}

  async loadAndBuild(ecsWorld: World) {
    const declaration = this.declaration

    const allMaterials = declaration.scene.objects.flatMap((o) => (o.type === 'mesh' ? [o.mesh.inventoryMaterial] : []))
    const allInventoryEntities = declaration.scene.objects.flatMap((o) =>
      o.type === 'inventoryEntity' ? [o.inventoryEntity] : [],
    )

    await Promise.all([
      ...allMaterials.map((id) => this.inventorySystem.load('material', id)),
      ...allInventoryEntities.map((id) => this.inventorySystem.load('entity', id)),
    ])

    for (const obj of declaration.scene.objects) {
      // todo: move out of class
      if (obj.type === 'mesh') this.ecsCommitMesh(ecsWorld, obj)
      if (obj.type === 'light') this.ecsCommitLight(ecsWorld, obj)
      if (obj.type === 'inventoryEntity') this.ecsCommitInventoryEntity(ecsWorld, obj)
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

  ecsCommitMesh(world: World, obj: MeshObject) {
    const geometry = new THREE.PlaneGeometry(obj.mesh.geometry.width, obj.mesh.geometry.height)
    const material = this.inventorySystem.get('material', obj.mesh.inventoryMaterial)
    const mesh = new THREE.Mesh(geometry, material)

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, ThreeObject)
    addComponent(world, eid, NeedSpawn)

    ThreeObject[eid] = mesh
    writeVec3Row(Position, eid, obj.position)
    writeVec3Row(Rotation, eid, obj.rotation)
  }

  ecsCommitLight(world: World, obj: LightObject) {
    const light =
      obj.light.kind === 'hemisphere'
        ? new THREE.HemisphereLight(obj.light.skyColor, obj.light.groundColor, obj.light.intensity)
        : new THREE.DirectionalLight(obj.light.color, obj.light.intensity)

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, ThreeObject)
    addComponent(world, eid, NeedSpawn)

    ThreeObject[eid] = light
    writeVec3Row(Position, eid, obj.position)
    writeVec3Row(Rotation, eid, obj.rotation)
  }

  ecsCommitInventoryEntity(world: World, obj: InventoryEntityObject) {
    const { threeObject, entityDeclaration } = this.inventorySystem.get('entity', obj.inventoryEntity)
    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, ThreeObject)
    addComponent(world, eid, NeedSpawn)
    addComponent(world, eid, InventoryEntityDeclaration)
    if (obj.isPlayer) addComponent(world, eid, IsPlayer)

    ThreeObject[eid] = threeObject
    InventoryEntityDeclaration[eid] = entityDeclaration
    writeVec3Row(Position, eid, obj.position)
    writeVec3Row(Rotation, eid, obj.rotation)
  }
}
