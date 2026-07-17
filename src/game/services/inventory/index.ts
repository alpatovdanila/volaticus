import * as THREE from 'three'

import {DUMMY_MATERIAL, loadSeparatePbrMaterial, configureKtx2} from './separate-pbr-material'
import {IEngineSystemsRegistry, IRenderer} from "../interfaces";
import {EngineSystem} from "../base-engine-system";


export const INVENTORY_TYPE = {
  SEPARATE_PBR_MATERIAL: 'separate_pbr_material',
} as const
export type InventoryType = (typeof INVENTORY_TYPE)[keyof typeof INVENTORY_TYPE]

type Loaded = THREE.Material
type Loader = (id: string) => Promise<Loaded>


const LOADERS: Record<InventoryType, Loader> = {
  [INVENTORY_TYPE.SEPARATE_PBR_MATERIAL]: loadSeparatePbrMaterial,
}

const DUMMIES: Record<InventoryType, Loaded> = {
  [INVENTORY_TYPE.SEPARATE_PBR_MATERIAL]: DUMMY_MATERIAL,
}

export class Inventory extends EngineSystem{
  private loaded: Record<InventoryType, Record<string, Loaded>> = {
    [INVENTORY_TYPE.SEPARATE_PBR_MATERIAL]: {},
  }

  private pending: Record<InventoryType, Record<string, Promise<Loaded>>> = {
    [INVENTORY_TYPE.SEPARATE_PBR_MATERIAL]: {},
  }

  private renderer!: IRenderer

  init(registry: IEngineSystemsRegistry) {
    this.renderer = registry.get<IRenderer>('renderer')
    // the transcode target depends on the device — wire it up once the renderer is up
    this.renderer.onReady(() => configureKtx2(this.renderer.getThreeRenderer()))
  }

  load(type: InventoryType, id: string): Promise<Loaded> {
    const done = this.loaded[type][id]
    if (done) return Promise.resolve(done)

    const inFlight = this.pending[type][id]
    if (inFlight) return inFlight

    const future = LOADERS[type](id).then((m) => {
      delete this.pending[type][id]
      this.loaded[type][id] = m
      return m
    })

    this.pending[type][id] = future
    return future
  }

  get(type: InventoryType, id: string): Loaded {
    const m = this.loaded[type][id]
    if (!m) {
      console.warn(`inventory: ${type}:${id} accessed before load, that should not happen`)
      return DUMMIES[type]
    }
    return m
  }
}

export type IInventory = InstanceType<typeof Inventory>