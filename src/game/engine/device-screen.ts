import { BaseService } from './services-registry'
import { createEvent } from '@shared/lib/atomic-event'

interface Resolution {
  width: number
  height: number
}

export class DeviceScreen extends BaseService {
  private resolution: Resolution = { width: window.innerWidth, height: window.innerHeight }
  private aspectRatio = window.innerWidth / window.innerHeight

  resolutionChanged = createEvent<Resolution>()

  aspectRatioChanged = createEvent<number>()

  create() {
    window.addEventListener('resize', this.reportResize)
  }

  async start() {
    this.reportResize()
  }

  private reportResize = () => {
    this.resolution = { width: window.innerWidth, height: window.innerHeight }
    this.aspectRatio = this.resolution.width / this.resolution.height

    this.resolutionChanged(this.resolution)
    this.aspectRatioChanged(this.aspectRatio)
  }
}

export type IDeviceScreen = InstanceType<typeof DeviceScreen>
