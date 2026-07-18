import * as THREE from 'three'

import { DUMMY_MATERIAL, loadInventoryMaterial, configureKtx2 } from './inventory-material'
import { DUMMY_ENTITY, loadEntity } from './inventory-entity'

import { BaseService, KnownServices, ServicesRegistry } from '../../services-registry'

interface InventoryTypes {
  material: THREE.Material
  entity: THREE.Object3D
}

const DUMMIES: { [K in keyof InventoryTypes]: InventoryTypes[K] } = {
  material: DUMMY_MATERIAL,
  entity: DUMMY_ENTITY,
}

const LOADERS: { [K in keyof InventoryTypes]: (id: string) => Promise<InventoryTypes[K]> } = {
  material: loadInventoryMaterial,
  entity: loadEntity,
}

export class Inventory extends BaseService {
  private renderer!: KnownServices['renderer']

  private resources: {
    [K in keyof InventoryTypes]: {
      pending: Record<string, Promise<InventoryTypes[K]>>
      loaded: Record<string, InventoryTypes[K]>
    }
  } = {
    entity: { pending: {}, loaded: {} },
    material: { pending: {}, loaded: {} },
  }

  init(registry: ServicesRegistry) {
    this.renderer = registry.get('renderer')
    this.renderer.onReady(() => configureKtx2(this.renderer.getThreeRenderer()))
  }

  async load<K extends keyof InventoryTypes>(type: K, id: string) {
    const loadedStore = this.resources[type].loaded
    const pendingStore = this.resources[type].pending

    const done = loadedStore[id]
    if (done) return Promise.resolve(done)

    const pending = pendingStore[id]
    if (pending) return pending

    const loader = LOADERS[type]

    const pendingResource = loader(id).then((resource) => {
      delete pendingStore[id]
      loadedStore[id] = resource
      return resource
    })

    pendingStore[id] = pendingResource
    return pendingResource
  }

  get<K extends keyof InventoryTypes>(type: K, id: string) {
    const resource = this.resources[type].loaded[id]
    if (!resource) {
      console.warn(`inventory: ${type}:${id} accessed before load, that should not happen`)
      return DUMMIES[type]
    }
    return resource
  }
}

export type IInventory = InstanceType<typeof Inventory>
