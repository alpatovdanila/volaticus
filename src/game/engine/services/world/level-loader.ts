import * as THREE from 'three'
import { Color, Scene } from 'three'
import { addEntity, addComponent, type World } from 'bitecs'

import {
  Position,
  Rotation,
  Velocity,
  ThreeAnimator,
  ThreeObject,
  NeedSpawn,
  writeVec3Row,
  IsPlayer,
  InventoryEntityDoc,
  AnimationProfile,
  IsAnimatorFree,
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

    const scene = new Scene()
    scene.background = new Color(declaration.scene.background)
    return scene
  }

  ecsCommitMesh(world: World, obj: MeshObject) {
    const { width, height, tiles } = obj.mesh.geometry
    const geometry = new THREE.PlaneGeometry(width, height)

    // tiling lives in the geometry's uvs, not in map.repeat: the material comes from the
    // shared inventory cache, so scaling its textures would retile every other mesh using it.
    if (tiles !== 1) geometry.attributes.uv.array.forEach((_, i, uv) => (uv[i] *= tiles))

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
    const eid = addEntity(world)
    addComponent(world, eid, ThreeObject)
    addComponent(world, eid, NeedSpawn)

    if (obj.light.kind === 'hemisphere') {
      // A hemisphere light has no location: three reads its sky *axis* from `position`, and
      // normalize(0,0,0) is NaN — which propagates through the lighting and blacks out every
      // lit material in the frame. So it gets no transform components on purpose, leaving
      // three's (0,1,0) default standing. ThreeSceneSync must never write to this entity.
      const { skyColor, groundColor, intensity } = obj.light
      ThreeObject[eid] = new THREE.HemisphereLight(skyColor, groundColor, intensity)
      return
    }

    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)

    ThreeObject[eid] = new THREE.DirectionalLight(obj.light.color, obj.light.intensity)
    writeVec3Row(Position, eid, obj.position)
    writeVec3Row(Rotation, eid, obj.rotation)
  }

  ecsCommitInventoryEntity(world: World, obj: InventoryEntityObject) {
    const { threeObject, entityDeclaration } = this.inventorySystem.get('entity', obj.inventoryEntity)

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, Velocity)
    addComponent(world, eid, ThreeObject)
    addComponent(world, eid, NeedSpawn)
    addComponent(world, eid, InventoryEntityDoc)

    if (obj.isPlayer) addComponent(world, eid, IsPlayer)

    if (entityDeclaration.animationProfile) {
      addComponent(world, eid, AnimationProfile)
      addComponent(world, eid, ThreeAnimator)
      addComponent(world, eid, IsAnimatorFree) // an animator is born unoccupied
      AnimationProfile[eid] = entityDeclaration.animationProfile
      ThreeAnimator[eid] = { mixer: new THREE.AnimationMixer(threeObject), currentClip: '', restartPending: false }
    }

    ThreeObject[eid] = threeObject
    InventoryEntityDoc[eid] = entityDeclaration

    writeVec3Row(Position, eid, obj.position)
    writeVec3Row(Rotation, eid, obj.rotation)
    writeVec3Row(Velocity, eid, [0, 0, 0])
  }
}
