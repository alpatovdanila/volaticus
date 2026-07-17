import * as THREE from 'three'

import {IInventory, INVENTORY_TYPE} from "../interfaces";
import {ICameraManagerSystem} from "../camera-manager";

interface PlaneGeometryDecl {
  type: 'plane'
  width: number
  height: number
  tiles?: number // texture repeats across the plane; 1 (default) stretches it once
}

type GeometryDecl = PlaneGeometryDecl

interface MeshDecl {
  type: 'mesh'
  geometry: GeometryDecl
  material: string
  position?: number[]
  rotation?: number[]
}

interface DirectionalLightDecl {
  type: 'directionalLight'
  color: string
  intensity: number
  position: number[]
}

interface HemisphereLightDecl {
  type: 'hemisphereLight'
  skyColor: string
  groundColor: string
  intensity: number
}

export type SceneObject = MeshDecl | DirectionalLightDecl | HemisphereLightDecl

export interface LevelDeclaration {
  scene: {
    background: string
    camera: {
      startingPosition: number[]
      startingRotation: number[]
    }
    objects: SceneObject[]
  }
}

export class Level {
  private declaration: LevelDeclaration
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera

  constructor(
    declaration: LevelDeclaration,
    private inventorySystem: IInventory,
    private cameraManager: ICameraManagerSystem,
  ) {
    this.declaration = declaration
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(declaration.scene.background)
    this.camera = this.cameraManager.createCamera()
    const c = declaration.scene.camera
    this.camera.position.set(c.startingPosition[0], c.startingPosition[1], c.startingPosition[2])
    this.camera.rotation.set(c.startingRotation[0], c.startingRotation[1], c.startingRotation[2])
  }

  async preloadResources(): Promise<void> {
    const materials = this.declaration.scene.objects.flatMap((o) => (o.type === 'mesh' ? [o.material] : []))
    await Promise.all(materials.map((id) => this.inventorySystem.load(INVENTORY_TYPE.SEPARATE_PBR_MATERIAL, id)))
  }

  build(): void {
    for (const obj of this.declaration.scene.objects) {
      this.scene.add(this.create(obj))
    }
  }

  private create(obj: SceneObject): THREE.Object3D {
    switch (obj.type) {
      case 'mesh': {
        const material = this.inventorySystem.get(INVENTORY_TYPE.SEPARATE_PBR_MATERIAL, obj.material)
        const mesh = new THREE.Mesh(this.geometry(obj.geometry), material)
        if (obj.position) mesh.position.set(obj.position[0], obj.position[1], obj.position[2])
        if (obj.rotation) mesh.rotation.set(obj.rotation[0], obj.rotation[1], obj.rotation[2])
        return mesh
      }
      case 'directionalLight': {
        const light = new THREE.DirectionalLight(obj.color, obj.intensity)
        light.position.set(obj.position[0], obj.position[1], obj.position[2])
        return light
      }
      case 'hemisphereLight':
        return new THREE.HemisphereLight(obj.skyColor, obj.groundColor, obj.intensity)
    }
  }

  private geometry(decl: GeometryDecl): THREE.BufferGeometry {
    switch (decl.type) {
      case 'plane': {
        const geo = new THREE.PlaneGeometry(decl.width, decl.height)
        const tiles = decl.tiles ?? 1
        if (tiles !== 1) {
          const uv = geo.attributes.uv
          for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * tiles, uv.getY(i) * tiles)
        }
        return geo
      }
    }
  }

  public teardown(): void {
    //
  }

  getScene(): THREE.Scene {
    return this.scene
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera
  }
}

export class DummyLevel extends Level {
  constructor(inventorySystem: IInventory, cameraManager: ICameraManagerSystem) {
    super(
      {
        scene: {
          background: '#000000',
          camera: { startingPosition: [0, 0, 0], startingRotation: [0, 0, 0] },
          objects: [],
        },
      },
      inventorySystem,
      cameraManager,
    )
  }
}
