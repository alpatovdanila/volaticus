import { WebGPURenderer } from 'three/webgpu'
import { EventEmitter } from '../../lib/event-emitter'

import { Timer } from 'three'
import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

export class Renderer extends BaseService {
  private threeRenderer = new WebGPURenderer({ antialias: true })
  private world!: KnownServices['world']
  private deviceScreen!: KnownServices['deviceScreen']
  private emitter = new EventEmitter()

  create() {
    this.threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    document.body.appendChild(this.threeRenderer.domElement)
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

    this.emitter.emit('ready')

    const timer = new Timer()

    timer.connect(document)

    const frame = (timestamp: number): void => {
      timer.update(timestamp) // advance ONCE per step, before any read
      const dt = Math.min(0.05, timer.getDelta()) // Timer has no clamp; a stall must not teleport the world

      //this.threeRenderer.render(this.world.getActive().getScene(), this.world.getCamera())

      requestAnimationFrame(frame)
    }

    requestAnimationFrame(frame)
  }

  onReady(handler: VoidFunction) {
    this.emitter.on('ready', handler)
  }

  getThreeRenderer(): WebGPURenderer {
    return this.threeRenderer
  }
}

export type IRenderer = InstanceType<typeof Renderer>
