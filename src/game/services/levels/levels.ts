import { Level, DummyLevel, type LevelDeclaration } from './level'
import devLevel from '../../levels/dev.json'
import { IEngineSystemsRegistry, IInventory } from '../interfaces'
import { ICameraManager } from '../camera-manager'
import {EngineSystem} from "../base-engine-system";

export class Levels extends EngineSystem {
  private inventory!: IInventory
  private cameraManager!: ICameraManager
  private activeLevel!: Level

  init(registry: IEngineSystemsRegistry): void {
    // levels need the systems injected — the placeholder can't exist before this point
    this.inventory = registry.get<IInventory>('inventory')
    this.cameraManager = registry.get<ICameraManager>('cameraManager')
    this.activeLevel = new DummyLevel(this.inventory, this.cameraManager)
  }

  start(): void {
    const level = new Level(devLevel as LevelDeclaration, this.inventory, this.cameraManager)
    void level.preloadResources().then(() => {
      level.build()
      this.activeLevel = level
    })
  }

  getActive(): Level {
    return this.activeLevel
  }
}

export type ILevels = InstanceType<typeof Levels>
