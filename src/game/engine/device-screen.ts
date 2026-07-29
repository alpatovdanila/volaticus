import { BaseService } from './services-registry'
import { createEvent } from '@shared/lib/atomic-event'

interface Resolution {
  width: number
  height: number
}

export class DeviceScreen extends BaseService {
  // zeroed rather than measured, so the first report is never mistaken for a no-op resize
  private resolution: Resolution = { width: 0, height: 0 }
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
    // mobile browsers fire resize whenever the url bar slides, often with identical dimensions.
    // Reconfiguring the swap chain for a size that did not change is churn at best
    if (window.innerWidth === this.resolution.width && window.innerHeight === this.resolution.height) return

    this.resolution = { width: window.innerWidth, height: window.innerHeight }
    this.aspectRatio = this.resolution.width / this.resolution.height

    this.resolutionChanged(this.resolution)
    this.aspectRatioChanged(this.aspectRatio)
  }
}

export type IDeviceScreen = InstanceType<typeof DeviceScreen>
