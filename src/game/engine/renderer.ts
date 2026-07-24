import { WebGPURenderer } from 'three/webgpu'

import { BaseService, IServicesRegistry, KnownServices } from './services-registry'

export class Renderer extends BaseService {
  private threeRenderer = new WebGPURenderer()
  private world!: KnownServices['world']
  private deviceScreen!: KnownServices['deviceScreen']
  private renderable = false
  private animationLoopCallback = (time: number) => {}

  create() {
    this.threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    document.body.appendChild(this.threeRenderer.domElement)
  }

  setAnimationLoopCallback(cb: (time: number) => void) {
    this.animationLoopCallback = cb
  }

  init(registry: IServicesRegistry): void {
    const deviceScreen = registry.get('deviceScreen')

    deviceScreen.resolutionChanged.on((resolution) => {
      this.threeRenderer.setSize(resolution.width, resolution.height)
    })
  }

  async start() {
    await this.threeRenderer.init()
    this.threeRenderer.setAnimationLoop((time) => this.animationLoopCallback(time))
  }

  update() {
    const camera = this.world.camera
    const scene = this.world.scene
    if (camera && scene) {
      this.threeRenderer.render(scene, camera)
    }
  }
}

export type IRenderer = InstanceType<typeof Renderer>
