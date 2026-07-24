import { Timer } from 'three'
import { IDeviceScreen } from './device-screen'
import { IRenderer } from './renderer'
import { IWorld } from './world'
import { IThreeSceneSync } from '@systems/three-scene-sync'
import { IMovement } from '@systems/movement'
import { ILevel } from './level'

export interface KnownServices {
  deviceScreen: IDeviceScreen
  renderer: IRenderer
  level: ILevel
  world: IWorld
  movement: IMovement
  threeSceneSync: IThreeSceneSync
}

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

    for (const service of servicesList) service.create()
    for (const service of servicesList) service.init(this)
    await Promise.all(servicesList.map((s) => s.start()))

    const render = this.get('renderer')

    const timer = new Timer()
    timer.connect(document)

    render.setAnimationLoopCallback((time) => {
      timer.update(time)
      const dt = Math.min(0.05, timer.getDelta())
      for (const service of servicesList) service.update(dt)
    })
  }
}

export type IServicesRegistry = InstanceType<typeof ServicesRegistry>
