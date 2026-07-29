import { LoadingManager, Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { WebGPURenderer } from 'three/webgpu'

import { ModelDeclaration, parseModelDeclaration } from '@inventory/schemas/model.schema'
import { JsonLoader } from './json-loader'

const MODELS = `${import.meta.env.BASE_URL}inventory/items/models`

export type LoadedModel = {
  object: Object3D
  doc: ModelDeclaration
}

/*
Resolves an inventory model id to its loaded scene. The item doc is a pointer — the model is the
baked GLB beside it, carrying the mesh, its skin and every animation clip merged from the source
FBXs.

Returns THE loaded object and its doc, one per id, not a copy: this loader loads and nothing else.

Which means two entities sharing a model id share one Object3D, and Object3D.add REPARENTS
rather than copies — the second spawn steals the object from the first, leaving one model driven
by two entities' transforms. Whoever adds a second model entity owns fixing that, by cloning
(SkeletonUtils.clone, not Object3D.clone — a skinned copy otherwise stays bound to these bones)
or by instancing.
*/
export class ModelLoader {
  private gltf: GLTFLoader
  private cache = new Map<string, Promise<LoadedModel>>()

  constructor(
    manager: LoadingManager,
    private json: JsonLoader,
    ktx2: KTX2Loader,
    private gpuReady: Promise<WebGPURenderer>,
  ) {
    this.gltf = new GLTFLoader(manager).setKTX2Loader(ktx2)
  }

  load(inventoryId: string): Promise<LoadedModel> {
    const cached = this.cache.get(inventoryId)
    if (cached) return cached

    const pending = this.read(inventoryId)
    this.cache.set(inventoryId, pending)
    pending.catch(() => this.cache.delete(inventoryId)) // a failed load must not poison the id forever
    return pending
  }

  private async read(inventoryId: string): Promise<LoadedModel> {
    await this.gpuReady

    const dir = `${MODELS}/${inventoryId}`
    const doc = parseModelDeclaration(inventoryId, await this.json.load(`${dir}/${inventoryId}.json`))
    const gltf = await this.gltf.loadAsync(`${dir}/${doc.file}`)

    // GLTFLoader hands animations back beside the scene rather than on it. Put them on the
    // object so a mixer can resolve a clip by NAME — the names the animationProfile holds —
    // through AnimationClip.findByName, which reads root.animations
    gltf.scene.animations = gltf.animations

    return { object: gltf.scene, doc }
  }
}
