import { WebGPURenderer } from 'three/webgpu'
import { EventEmitter } from '../../lib/event-emitter'

import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

export class Renderer extends BaseService {
  private threeRenderer = new WebGPURenderer({ antialias: true })
  private world!: KnownServices['world']
  private deviceScreen!: KnownServices['deviceScreen']
  private emitter = new EventEmitter()
  private animationLoopCallback = (time: number) => {}

  create() {
    this.threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    document.body.appendChild(this.threeRenderer.domElement)
  }

  setAnimationLoopCallback(cb: (time: number) => void) {
    this.animationLoopCallback = cb
  }

  init(registry: IServicesRegistry): void {
    this.deviceScreen = registry.get('deviceScreen')
    this.world = registry.get('world')
    this.deviceScreen.onResolutionChanged((resolution) => {
      this.threeRenderer.setSize(resolution.width, resolution.height)
    })
  }

  async start() {
    await this.threeRenderer.init()
    this.emitter.emit('start')
    this.threeRenderer.setAnimationLoop((time) => this.animationLoopCallback(time))
  }

  public onReady(cb: VoidFunction) {
    this.emitter.on('ready', cb)
  }

  update() {
    this.threeRenderer.render(this.world.scene, this.world.camera)
  }

  getThreeRenderer() {
    return this.threeRenderer
  }
}

export type IRenderer = InstanceType<typeof Renderer>
