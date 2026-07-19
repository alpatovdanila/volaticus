// Imported glTF/GLB character models (resources/models/**/index.glb). Unlike meshes.ts
// (static FBX, merged into one geometry, skin/anim dropped), this preserves the model's
// native SKELETON, per-mesh SkinnedMeshes, PBR MATERIALS and AnimationClips — the model
// is used AS-IS (its own textures included; no in-editor material editing). AnimationsDriver
// clips are assumed already named (see scripts/import-glb.ts).
//
// Loading is async. The raw parse is cached once per path; each build gets a fresh
// SkeletonUtils clone (a THREE.Skeleton can't be shared across live instances) while the
// stateless AnimationClips are shared.
import * as THREE from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { clone as cloneHierarchy } from 'three/addons/utils/SkeletonUtils.js'

import { mergeFbxClips, type FbxAnimSource } from './fbx-anim-merge'

export interface GltfModel {
  scene: THREE.Object3D // the model, WITH its own materials (a fresh clone)
  meshes: THREE.Mesh[] // every (skinned) mesh, for picking / visibility / shadow flags
  clips: THREE.AnimationClip[] // the model's animation clips (already named), shared across clones
}

interface RawGltf {
  scene: THREE.Object3D
  clips: THREE.AnimationClip[]
}

const loader = new GLTFLoader()
const fbxLoader = new FBXLoader()
const rawCache = new Map<string, RawGltf>()
const pending = new Map<string, Promise<void>>()

// cache key folds in the merged anim files: same GLB with a different anim set is a distinct entry
function keyFor(path: string, animFiles: string[]): string {
  return animFiles.length ? path + '|' + animFiles.join(',') : path
}

// Fetch the sibling FBX files, then hand them to the shared retarget in fbx-anim-merge.ts —
// the same code scripts/bake-anims.ts runs offline, so a baked clip is identical to a
// runtime-merged one. Models whose clips are already baked into the GLB pass animFiles: [].
async function loadAndMergeFbxClips(
  scene: THREE.Object3D,
  glbPath: string,
  animFiles: string[],
): Promise<THREE.AnimationClip[]> {
  const dir = glbPath.slice(0, glbPath.lastIndexOf('/') + 1)
  const sources: FbxAnimSource[] = []
  for (const af of animFiles) {
    try {
      // encodeURI leaves '/' literal — matches the on-disk path under vite publicDir:'resources'
      const root = await fbxLoader.loadAsync('/' + encodeURI(dir + af))
      sources.push({ name: af.replace(/\.fbx$/i, ''), root })
    } catch (e) {
      console.warn('anim merge: failed to load', af, e)
    }
  }
  return mergeFbxClips(scene, sources)
}

// Tripo/Blender character exports frequently flag the material `alphaMode: BLEND` even
// though the mesh is fully opaque (opacity 1, no alpha/cutout). glTF→three turns that into
// transparent + depthWrite:false — so on a SOLID model the depth buffer isn't written and
// back/inside faces bleed through the front, reading as "flipped normals" (Blender's
// viewport hides it since it sorts differently). Revert those spuriously-transparent
// materials to opaque so depth sorting works. Genuinely translucent (opacity<1) or cutout
// (alphaTest>0 / alphaMap) materials are left alone.
function normalizeGlbMaterials(scene: THREE.Object3D): void {
  const seen = new Set<THREE.Material>()
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = mat as THREE.MeshStandardMaterial
      if (!m || seen.has(m)) continue
      seen.add(m)
      if (m.transparent && m.opacity >= 1 && !m.alphaMap && (m.alphaTest ?? 0) === 0) {
        m.transparent = false
        m.depthWrite = true
        m.needsUpdate = true
      }
      // IBL rides scene.environment (live), NOT a per-material envMap snapshot: GLTFLoader
      // makes a CLASSIC MeshStandardMaterial, which attachEnv would otherwise hand the
      // current PMREM env texture — that texture is DISPOSED on the next HDRI swap, leaving
      // the material pointing at freed memory → the model goes black and never recovers.
      // scene.environment is a live scene property (re-read each frame), so it survives swaps.
      m.userData.iblFromScene = true
    }
  })
}

// Convert the GLB's CLASSIC materials to real NODE materials. The rest of the engine is
// node-native (catalog materials, grafts, the whole WebGPU stack); classic materials only
// exist here because GLTFLoader emits them — and they keep paying for it: the transient
// classic→node wrapper in three r185 provably LOSES live scene.environmentRotation (a
// node-material mirror follows the env yaw, a classic one doesn't — patch-verified), plus
// the earlier envMap-crash and baked-emissive-lift workarounds were classic-only. One
// conversion at load and imported models are first-class citizens: same property names,
// so a shallow copy carries maps/factors verbatim (mirrors three's NodeLibrary.fromMaterial).
function toNodeMaterials(scene: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.Material>()
  const convert = (m: THREE.Material): THREE.Material => {
    const cached = converted.get(m)
    if (cached) return cached
    if ((m as { isNodeMaterial?: boolean }).isNodeMaterial) return m
    if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m // unlit/basic — leave alone
    const nm = (m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial
      ? new MeshPhysicalNodeMaterial()
      : new MeshStandardNodeMaterial()
    for (const key in m)
      (nm as unknown as Record<string, unknown>)[key] = (m as unknown as Record<string, unknown>)[key]
    converted.set(m, nm)
    return nm
  }
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material)
  })
}

// Fetch + parse a GLB once (+ merge any sibling FBX clips), cache the raw scene + clips.
export function preloadGltf(path: string, animFiles: string[] = []): Promise<void> {
  const key = keyFor(path, animFiles)
  if (rawCache.has(key)) return Promise.resolve()
  let p = pending.get(key)
  if (!p) {
    // encodeURI leaves '/' literal — matches the on-disk path under vite publicDir:'resources'
    p = loader
      .loadAsync('/' + encodeURI(path))
      .then(async (gltf) => {
        normalizeGlbMaterials(gltf.scene)
        toNodeMaterials(gltf.scene)
        const merged = animFiles.length ? await loadAndMergeFbxClips(gltf.scene, path, animFiles) : []
        const clips = [...gltf.animations, ...merged]
        // GLTFLoader hands animations back as a sibling of the scene, never attached to it.
        // Attaching them lets mixer.clipAction(name) resolve; Object3D.copy slices the array,
        // so every clone gets its own list pointing at the same shared clips.
        gltf.scene.animations = clips
        rawCache.set(key, { scene: gltf.scene, clips })
      })
      .catch((e) => {
        console.warn('GLB load failed:', path, e)
        throw e
      })
      .finally(() => {
        pending.delete(key)
      })
    pending.set(key, p)
  }
  return p
}

// A fresh, independently-animatable instance from the cache (null if not yet loaded).
// SkeletonUtils.clone rebinds the SkinnedMeshes to a freshly cloned skeleton; clips bind
// by bone NAME at play time, so the cached clips drive any clone.
export function getGltfInstance(path: string, animFiles: string[] = []): GltfModel | null {
  const raw = rawCache.get(keyFor(path, animFiles))
  if (!raw) return null
  const scene = cloneHierarchy(raw.scene)
  const meshes: THREE.Mesh[] = []
  scene.traverse((o) => {
    if ((o as unknown as { isMesh?: boolean }).isMesh) meshes.push(o as THREE.Mesh)
  })
  return { scene, meshes, clips: raw.clips }
}

export async function loadGltfModel(path: string, animFiles: string[] = []): Promise<GltfModel> {
  await preloadGltf(path, animFiles)
  const inst = getGltfInstance(path, animFiles)
  if (!inst) throw new Error('GLB not in cache after load: ' + path)
  return inst
}

// Clip names for a loaded model (for the states dropdown / browser-side validation).
export function gltfClipNames(path: string, animFiles: string[] = []): string[] {
  return rawCache.get(keyFor(path, animFiles))?.clips.map((c) => c.name) ?? []
}
