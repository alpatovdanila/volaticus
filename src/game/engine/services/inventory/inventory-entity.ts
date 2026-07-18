import * as THREE from 'three'
import { InventoryEntityDeclaration, parseInventoryEntityDeclaration } from '../../../../shared/inventory-schema'
import { loadGltfModel } from '../../../../inventory/gltf'

// globbed as unknown: the doc is validated on load, never asserted
const ENTITY_DOCS = import.meta.glob<{ default: unknown }>('/inventory/entities/*/*.json')

type EntityLoaderResult = {
  threeObject: THREE.Object3D
  clips: THREE.AnimationClip[]
  entityDeclaration: InventoryEntityDeclaration
}

export const loadEntity = async (id: string): Promise<EntityLoaderResult> => {
  const entry = ENTITY_DOCS[`/inventory/entities/${id}/${id}.json`]
  if (!entry) throw new Error(`inventory: no entity '${id}'`)
  const doc = parseInventoryEntityDeclaration(id, (await entry()).default)

  // sibling FBX clips are merged onto the GLB skeleton by the loader
  const model = await loadGltfModel(doc.model.src, doc.model.anims ?? [])

  return {
    threeObject: model.scene,
    clips: model.clips,
    entityDeclaration: doc,
  }
}

export const DUMMY_ENTITY: EntityLoaderResult = {
  threeObject: new THREE.Object3D(),
  clips: [],
  entityDeclaration: {
    id: '__dummy',
    model: { src: '' },
  },
}
