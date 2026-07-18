import { EventEmitter } from '../../lib/event-emitter'

import { BaseService } from '../services-registry'

interface Resolution {
  width: number
  height: number
}

export class DeviceScreen extends BaseService {
  private resolution: Resolution = { width: window.innerWidth, height: window.innerHeight }
  private aspectRatio = window.innerWidth / window.innerHeight
  private pixelRatio = window.devicePixelRatio
  private emitter = new EventEmitter()

  create() {
    window.addEventListener('resize', this.reportResize)
  }

  private reportResize = () => {
    this.resolution = { width: window.innerWidth, height: window.innerHeight }
    this.aspectRatio = this.resolution.width / this.resolution.height
    this.pixelRatio = window.devicePixelRatio
    this.emitter.emit('resolutionChange', this.resolution)
    this.emitter.emit('aspectRatioChange', this.aspectRatio)
  }

  async start() {
    this.reportResize()
  }

  onResolutionChanged(handler: (resolution: Resolution) => void) {
    this.emitter.on('resolutionChange', handler)
  }

  onAspectRatioChanged(handler: (aspectRatio: number) => void) {
    this.emitter.on('aspectRatioChange', handler)
  }
}

export type IDeviceScreen = InstanceType<typeof DeviceScreen>
