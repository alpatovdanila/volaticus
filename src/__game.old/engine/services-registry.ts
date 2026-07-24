import { Timer } from 'three'

import type { IDeviceScreen } from './services/device-screen'
import type { IRenderer } from './services/renderer'

import type { IInventory } from './services/inventory'

import { IWorld } from './services/world/world'
import type { IInput } from './services/input'
import type { IPlayerControl } from './services/player/player-control'
import type { IMovement } from './services/movement'
import type { IThreeSceneSync } from './services/three-scene-sync'
import type { IAnimation } from './services/animations/animations-driver'

import type { IDebugOverlay } from './services/debug-overlay'
import type { ICameraControl } from './services/camera-control'
import { ILocomotionAnimation } from './services/animations/locomotion-animation'
import type { IEventsAnimations } from './services/animations/events-animations'

export interface KnownServices {
  deviceScreen: IDeviceScreen
  renderer: IRenderer
  world: IWorld
  inventory: IInventory
  input: IInput
  playerControl: IPlayerControl
  movement: IMovement
  threeSceneSync: IThreeSceneSync
  animation: IAnimation
  locomotionAnimation: ILocomotionAnimation
  eventsAnimations: IEventsAnimations
  debugOverlay: IDebugOverlay
  cameraControl: ICameraControl
}

export interface IService {
  shouldUpdate: boolean

  create(): void

  init(registry: IServicesRegistry): void

  start(): Promise<void>

  update(dt: number): void
}

export class BaseService implements IService {
  shouldUpdate = true

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
      for (const service of servicesList) {
        if (service.shouldUpdate) service.update(dt)
      }
    })
  }
}

export type IServicesRegistry = InstanceType<typeof ServicesRegistry>
