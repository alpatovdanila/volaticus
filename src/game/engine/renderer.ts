import { AgXToneMapping, WebGPURenderer } from 'three/webgpu'

import { BaseService, IServicesRegistry, KnownServices } from './services-registry'
import { createEvent } from '@shared/lib/atomic-event'

/*
Display transform for the hdr scene — edit by hand, swapping the import for another of three's:
  NoToneMapping         raw, clips everything above 1
  LinearToneMapping     exposure only, still clips
  ReinhardToneMapping   old, desaturates as it rolls off
  CineonToneMapping     old film emulation
  ACESFilmicToneMapping punchy, pulls saturated highlights toward white
  AgXToneMapping        filmic, holds hue through the roll-off
  NeutralToneMapping    khronos pbr neutral, closest to the source colours
*/
const TONE_MAPPING = AgXToneMapping
const TONE_MAPPING_EXPOSURE = 1

export class Renderer extends BaseService {
  // trackTimestamp puts gpu frame time in info.render.timestamp. It obliges us to drain the
  // query pool every frame (see update) — an unresolved pool fills up and stops recording
  readonly webGPURenderer = new WebGPURenderer({ antialias: true, trackTimestamp: true })
  private world!: KnownServices['world']
  private animationLoopCallback = (time: number) => {}
  public becomeReady = createEvent()

  create() {
    this.webGPURenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.webGPURenderer.toneMapping = TONE_MAPPING
    this.webGPURenderer.toneMappingExposure = TONE_MAPPING_EXPOSURE
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
    // not awaited: repeat calls return the in-flight resolve, and the value lands in
    // info.render.timestamp a frame or so later, which is soon enough to read
    void this.webGPURenderer.resolveTimestampsAsync()
  }
}

export type IRenderer = InstanceType<typeof Renderer>
