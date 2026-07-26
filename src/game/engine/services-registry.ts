import { Timer } from 'three'
import { IDeviceScreen } from './device-screen'
import { IRenderer } from './renderer'
import { IWorld } from './world'
import { IThreeSceneSync } from '@systems/three-scene-sync'
import { IThreeAnimatorSync } from '@systems/three-animator-sync'
import { IMovement } from '@systems/movement'
import { IDestroy } from '@systems/destroy'
import { ILoader } from './loader'
import { ILevel } from './level'
import { IDevOverlay } from './dev-overlay'

export interface KnownServices {
  deviceScreen: IDeviceScreen
  renderer: IRenderer
  loader: ILoader
  level: ILevel
  world: IWorld
  movement: IMovement
  threeAnimatorSync: IThreeAnimatorSync
  threeSceneSync: IThreeSceneSync
  destroy: IDestroy
  devOverlay: IDevOverlay
}

export type ServiceTimings = Partial<Record<keyof KnownServices, number>>

export interface IService {
  create(): void

  init(registry: IServicesRegistry): void

  start(): Promise<void>

  update(dt: number): void
}

export class BaseService implements IService {
  create() {}

  init(registry: IServicesRegistry) {}

  async start() {}

  update(dt: number) {}
}

export class ServicesRegistry {
  private services = new Map<keyof KnownServices, IService>()

  // wall time of the last frame's update loop, and where it went. The registry owns the loop,
  // so it is the only place that can measure this
  cpuTime = 0
  readonly timings: ServiceTimings = {}

  register<K extends keyof KnownServices>(name: K, system: KnownServices[K]) {
    this.services.set(name, system)
    return system
  }

  get<K extends keyof KnownServices>(name: K): KnownServices[K] {
    const service = this.services.get(name)
    if (!service) throw new Error(`Service ${name} not found!`)
    return service as unknown as KnownServices[K]
  }

  async start() {
    const servicesList = [...this.services.values()]
    const named = [...this.services.entries()]

    for (const service of servicesList) service.create()
    for (const service of servicesList) service.init(this)
    await Promise.all(servicesList.map((s) => s.start()))

    const render = this.get('renderer')

    const timer = new Timer()
    timer.connect(document)

    render.setAnimationLoopCallback((time) => {
      timer.update(time)
      const dt = Math.min(0.05, timer.getDelta())

      const frameStart = performance.now()
      for (const [name, service] of named) {
        const serviceStart = performance.now()
        service.update(dt)
        this.timings[name] = performance.now() - serviceStart
      }
      this.cpuTime = performance.now() - frameStart
    })
  }
}

export type IServicesRegistry = InstanceType<typeof ServicesRegistry>
