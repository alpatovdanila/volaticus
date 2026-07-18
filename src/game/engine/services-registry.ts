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

  start(): void

  update(dt: number): void
}

export class BaseService implements IService {
  create() {}

  init(registry: IServicesRegistry) {}

  start() {}

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
    for (const service of servicesList) void service.start()

    const clock = new Timer()
    clock.connect(document)

    const loop = () => {
      const delta = clock.getDelta()
      for (const service of servicesList) service.update(delta)
      requestAnimationFrame(loop)
    }

    loop()
  }
}

export type IServicesRegistry = InstanceType<typeof ServicesRegistry>
