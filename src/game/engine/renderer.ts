import { WebGPURenderer } from 'three/webgpu'

import { BaseService, IServicesRegistry, KnownServices } from './services-registry'
import { createEvent } from '@shared/lib/atomic-event'

export class Renderer extends BaseService {
  readonly webGPURenderer = new WebGPURenderer({ antialias: true })
  private world!: KnownServices['world']
  private animationLoopCallback = (time: number) => {}
  public becomeReady = createEvent()

  create() {
    this.webGPURenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    document.body.appendChild(this.webGPURenderer.domElement)
  }

  setAnimationLoopCallback(cb: (time: number) => void) {
    this.animationLoopCallback = cb
  }

  init(registry: IServicesRegistry) {
    const deviceScreen = registry.get('deviceScreen')
    this.world = registry.get('world')
    deviceScreen.resolutionChanged.on((resolution) => {
      this.webGPURenderer.setSize(resolution.width, resolution.height)
    })
  }

  async start() {
    await this.webGPURenderer.init()
    this.becomeReady()
    this.webGPURenderer.setAnimationLoop((time) => this.animationLoopCallback(time))
  }

  update() {
    this.webGPURenderer.render(this.world.scene, this.world.camera)
  }
}

export type IRenderer = InstanceType<typeof Renderer>
