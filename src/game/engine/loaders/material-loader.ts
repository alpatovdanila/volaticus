import { LoadingManager, Material, Mesh, RepeatWrapping, Texture } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'

import { parseMaterialDeclaration } from '@inventory/schemas/material.schema'
import { IServicesRegistry, KnownServices } from '@engine/services-registry'
import { JsonLoader } from './json-loader'

const MATERIALS = '/inventory/items/materials'
const TRANSCODER = '/node_modules/three/examples/jsm/libs/basis/'

/*
Resolves an inventory material id to a three Material. The item doc is a pointer — the material
itself lives in the GLB beside it, carried on a unit-quad mesh so loaders can instantiate it.

Materials are SHARED: one instance per id, handed to every object that asks. That is why nothing
here ever disposes, and why tiling is metered into geometry UVs by the caller instead of into
texture.repeat, which would have objects of different sizes fighting over one texture.
*/
export class MaterialLoader {
  private ktx2: KTX2Loader
  private gltf: GLTFLoader
  private cache = new Map<string, Promise<Material>>()
  private ktxSupportDetection!: Promise<void>
  private maxAnisotropy = 1

  constructor(
    manager: LoadingManager,
    private json: JsonLoader,
  ) {
    this.ktx2 = new KTX2Loader(manager).setTranscoderPath(TRANSCODER)
    this.gltf = new GLTFLoader(manager).setKTX2Loader(this.ktx2)
  }

  load(inventoryId: string): Promise<Material> {
    const cached = this.cache.get(inventoryId)
    if (cached) return cached

    const pending = this.read(inventoryId)
    this.cache.set(inventoryId, pending)
    return pending
  }

  init(renderer: KnownServices['renderer']) {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.ktxSupportDetection = promise

    renderer.becomeReady.on(() => {
      this.ktx2.detectSupport(renderer.webGPURenderer)
      this.maxAnisotropy = renderer.webGPURenderer.getMaxAnisotropy()
      resolve()
    })
  }

  private async read(inventoryId: string): Promise<Material> {
    await this.ktxSupportDetection

    const dir = `${MATERIALS}/${inventoryId}`
    const doc = parseMaterialDeclaration(inventoryId, await this.json.load(`${dir}/${inventoryId}.json`))
    const gltf = await this.gltf.loadAsync(`${dir}/${doc.file}`)

    let material: Material | null = null
    gltf.scene.traverse((object) => {
      if (material || !(object instanceof Mesh)) return
      material = Array.isArray(object.material) ? object.material[0] : object.material
    })
    if (!material) throw new Error(`material '${inventoryId}': ${doc.file} carries no mesh to take a material from`)

    for (const map of maps(material)) {
      map.wrapS = map.wrapT = RepeatWrapping
      map.anisotropy = this.maxAnisotropy
    }
    return material
  }
}

const maps = (material: Material): Texture[] =>
  Object.values(material as unknown as Record<string, unknown>).filter(
    (value): value is Texture => value instanceof Texture,
  )
