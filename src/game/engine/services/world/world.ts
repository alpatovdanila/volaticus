import { createWorld as createEcsWorld } from 'bitecs'
import { PerspectiveCamera, Scene } from 'three'
import { BaseService, IServicesRegistry, KnownServices } from '../../services-registry'
import { LevelDeclaration } from './level-schema'
import { LevelLoader } from './level-loader'

export class World extends BaseService {
  private inventory!: KnownServices['inventory']
  private screen!: KnownServices['deviceScreen']
  readonly ecs = createEcsWorld()
  camera: PerspectiveCamera = new PerspectiveCamera() // dummy starting camera
  scene: Scene = new Scene() // dummy starting scene

  init(registry: IServicesRegistry): void {
    this.inventory = registry.get('inventory')
    this.screen = registry.get('deviceScreen')

    // todo: find a better place? Separate CameraResize controller? Camera wrapper?
    this.screen.onAspectRatioChanged((aspect) => {
      console.log('aspect ratio changed')
      if (this.camera) {
        this.camera.aspect = aspect
        this.camera.updateProjectionMatrix()
      }
    })
  }

  async loadLevel(levelDeclaration: LevelDeclaration) {
    const levelLoader = new LevelLoader(levelDeclaration, this.inventory)
    const { camera, scene } = await levelLoader.loadAndBuild(this.ecs, this.screen.aspect)
    this.camera = camera
    this.scene = scene
  }
}

export type IWorld = InstanceType<typeof World>
