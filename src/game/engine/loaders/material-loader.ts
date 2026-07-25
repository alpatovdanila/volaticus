import { LoadingManager, Material, Mesh, RepeatWrapping, Texture } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { WebGPURenderer } from 'three/webgpu'

import { parseMaterialDeclaration } from '@inventory/schemas/material.schema'
import { JsonLoader } from './json-loader'

const MATERIALS = '/inventory/items/materials'

/*
Resolves an inventory material id to a three Material. The item doc is a pointer — the material
itself lives in the GLB beside it, carried on a unit-quad mesh so loaders can instantiate it.

Materials are SHARED: one instance per id, handed to every object that asks. That is why nothing
here ever disposes, and why tiling is metered into geometry UVs by the caller instead of into
texture.repeat, which would have objects of different sizes fighting over one texture.
*/
export class MaterialLoader {
  private gltf: GLTFLoader
  private cache = new Map<string, Promise<Material>>()

  constructor(
    manager: LoadingManager,
    private json: JsonLoader,
    ktx2: KTX2Loader,
    private gpuReady: Promise<WebGPURenderer>,
  ) {
    this.gltf = new GLTFLoader(manager).setKTX2Loader(ktx2)
  }

  load(inventoryId: string): Promise<Material> {
    const cached = this.cache.get(inventoryId)
    if (cached) return cached

    const pending = this.read(inventoryId)
    this.cache.set(inventoryId, pending)
    pending.catch(() => this.cache.delete(inventoryId)) // a failed load must not poison the id forever
    return pending
  }

  private async read(inventoryId: string): Promise<Material> {
    const renderer = await this.gpuReady

    const dir = `${MATERIALS}/${inventoryId}`
    const doc = parseMaterialDeclaration(inventoryId, await this.json.load(`${dir}/${inventoryId}.json`))
    const gltf = await this.gltf.loadAsync(`${dir}/${doc.file}`)

    let material: Material | null = null
    gltf.scene.traverse((object) => {
      if (material || !(object instanceof Mesh)) return
      material = Array.isArray(object.material) ? object.material[0] : object.material
    })
    if (!material) throw new Error(`material '${inventoryId}': ${doc.file} carries no mesh to take a material from`)

    const maxAnisotropy = renderer.getMaxAnisotropy()
    for (const map of maps(material)) {
      map.wrapS = map.wrapT = RepeatWrapping
      map.anisotropy = maxAnisotropy
    }
    return material
  }
}

const maps = (material: Material): Texture[] =>
  Object.values(material as unknown as Record<string, unknown>).filter(
    (value): value is Texture => value instanceof Texture,
  )
