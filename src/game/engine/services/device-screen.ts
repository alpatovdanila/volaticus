import { createEvent } from '../../../lib/atomic-event'
import { BaseService } from '../services-registry'

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

  private reportResize = () => {
    this.resolution = { width: window.innerWidth, height: window.innerHeight }
    this.aspectRatio = this.resolution.width / this.resolution.height

    this.resolutionChanged(this.resolution)
    this.aspectRatioChanged(this.aspectRatio)
  }

  async start() {
    this.reportResize()
  }
}

export type IDeviceScreen = InstanceType<typeof DeviceScreen>
