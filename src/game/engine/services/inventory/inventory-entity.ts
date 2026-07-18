import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'


interface EntityDoc {
  id: string
  model: { src: string } // path relative to resources/, e.g. "models/marine2/index.glb"
}

const ENTITY_DOCS = import.meta.glob<{ default: EntityDoc }>('/inventory/entities/*/*.json')

const gltfLoader = new GLTFLoader()

export const loadEntity = async (id: string): Promise<THREE.Object3D> => {
  const entry = ENTITY_DOCS[`/inventory/entities/${id}/${id}.json`]
  if (!entry) throw new Error(`inventory: no entity '${id}'`)
  const doc = (await entry()).default
  const gltf = await gltfLoader.loadAsync('/' + doc.model.src) // src is resources-relative → root URL
  return gltf.scene
}

export const DUMMY_ENTITY = new THREE.Object3D()
DUMMY_ENTITY.name = 'dummy-entity'
