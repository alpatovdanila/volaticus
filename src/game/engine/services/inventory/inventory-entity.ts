import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { InventoryEntityDeclaration } from '../../../../shared/type'

const ENTITY_DOCS = import.meta.glob<{ default: InventoryEntityDeclaration }>('/inventory/entities/*/*.json')

const gltfLoader = new GLTFLoader()

type EntityLoaderResult = {
  threeObject: THREE.Object3D
  entityDeclaration: InventoryEntityDeclaration
}

export const loadEntity = async (id: string): Promise<EntityLoaderResult> => {
  const entry = ENTITY_DOCS[`/inventory/entities/${id}/${id}.json`]
  if (!entry) throw new Error(`inventory: no entity '${id}'`)
  const doc = (await entry()).default
  const gltf = await gltfLoader.loadAsync('/' + doc.model.src) // src is resources-relative → root URL
  return {
    threeObject: gltf.scene,
    entityDeclaration: doc,
  }
}

export const DUMMY_ENTITY: EntityLoaderResult = {
  threeObject: new THREE.Object3D(),
  entityDeclaration: {
    id: '__dummy',
    model: { src: '' },
  },
}
