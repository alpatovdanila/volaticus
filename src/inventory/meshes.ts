// External low-poly meshes (FBX, e.g. the craftpix packs under resources/).
// A mesh file is merged into ONE BufferGeometry and cached; rig nodes with
// shape "mesh" reference it and get a normal material slot (the pack's texture
// atlas), so picking, outlines, anims and the editor all treat it uniformly.
// Loading is async — call preloadEntityMeshes(doc) before buildEntity.
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { walkRig, type EntityDoc } from './schema'

const cache = new Map<string, THREE.BufferGeometry>()
const pending = new Map<string, Promise<void>>()
// FBXLoader keeps its parse state in module-level variables and is NOT
// re-entrant — concurrent loads corrupt each other. Serialize all loads.
let loadQueue: Promise<unknown> = Promise.resolve()

// FBX files reference their textures by the artist's local paths — we apply our
// own slot materials anyway, so feed the loader a 1px placeholder for anything
// that isn't the model file itself (avoids 404 spam).
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const manager = new THREE.LoadingManager()
manager.setURLModifier((url) => (url.toLowerCase().includes('.fbx') ? url : PIXEL))
const loader = new FBXLoader(manager)

export function getMeshGeometry(path: string): THREE.BufferGeometry | null {
  return cache.get(path) ?? null
}

export function preloadMesh(path: string): Promise<void> {
  if (cache.has(path)) return Promise.resolve()
  let p = pending.get(path)
  if (!p) {
    p = (loadQueue = loadQueue.then(() =>
      loader
        .loadAsync('/' + encodeURI(path))
        .then((scene) => {
          scene.updateMatrixWorld(true)
          const parts: THREE.BufferGeometry[] = []
          scene.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (!mesh.isMesh) return
            let g = mesh.geometry.clone()
            if (g.index) g = g.toNonIndexed()
            g.applyMatrix4(mesh.matrixWorld)
            for (const key of Object.keys(g.attributes))
              if (!['position', 'normal', 'uv'].includes(key)) g.deleteAttribute(key)
            g.clearGroups()
            parts.push(g)
          })
          if (parts.length === 0) throw new Error('no meshes inside file')
          const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
          cache.set(path, merged)
        })
        .catch((e) => {
          console.warn('mesh load failed:', path, e)
          cache.set(path, new THREE.BoxGeometry(0.4, 0.4, 0.4)) // visible placeholder
        }),
    )) as Promise<void>
    pending.set(path, p)
  }
  return p
}

export function collectMeshPaths(doc: EntityDoc): string[] {
  const paths: string[] = []
  walkRig(doc.rig, (_name, node) => {
    if (node.shape === 'mesh' && node.mesh) paths.push(node.mesh)
  })
  return paths
}

export async function preloadEntityMeshes(doc: EntityDoc): Promise<void> {
  await Promise.all(collectMeshPaths(doc).map(preloadMesh))
}
