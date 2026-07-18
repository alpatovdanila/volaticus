import { Timer } from 'three'

import type { IDeviceScreen } from './services/device-screen'
import type { IRenderer } from './services/renderer'

import type { IInventory } from './services/inventory'
import { ISceneSpawn } from './services/scene-spawn'
import { IWorld } from './services/world/world'

export interface KnownServices {
  deviceScreen: IDeviceScreen
  renderer: IRenderer
  world: IWorld
  inventory: IInventory
  sceneSpawn: ISceneSpawn
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
    console.log(`[engine] Registered services`, servicesList)

    for (const service of servicesList) service.create()
    for (const service of servicesList) service.init(this)
    await Promise.all(servicesList.map((s) => s.start()))

    const render = this.get('renderer')
    if (!render) throw new Error('Renderer service is not optional, please, register it')

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
