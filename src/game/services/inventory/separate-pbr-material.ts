import * as THREE from 'three'
import { MeshStandardNodeMaterial, WebGPURenderer } from 'three/webgpu'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'



export const DUMMY_MATERIAL = new MeshStandardNodeMaterial()
DUMMY_MATERIAL.name = 'dummy'
DUMMY_MATERIAL.color.set('#ff00ff')

interface SeparatePbrMaterialDoc {
  id: string
  maps: {
    color: string | null
    normal: string | null
    roughness: string | null
    metallic: string | null
    ao: string | null
    height: string | null
  }
  tuning: {
    roughness: number
    metalness: number
    normalScale: number
    aoIntensity: number
    opacity: number
    cutout: boolean
    doubleSided: boolean
  }
}

// Material docs live under inventory/ (outside publicDir), so they can't be fetched by
// URL — bundle them by id. glob keys are the full paths, e.g.
// '/inventory/materials/concrete_ground_01.json'.
const MATERIAL_DOCS = import.meta.glob<{ default: SeparatePbrMaterialDoc }>('/inventory/materials/*.json')

// KTX2: the catalog ships block-compressed textures. The transcoder needs the
// initialized renderer to pick a target format, so every load waits on it. The Inventory
// system calls configureKtx2 once the renderer is ready (see Inventory.init), which
// unblocks every queued map load.
const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/')
let resolveKtx2Ready!: () => void
const ktx2Ready = new Promise<void>((resolve) => {
  resolveKtx2Ready = resolve
})

export function configureKtx2(threeRenderer: WebGPURenderer): void {
  ktx2Loader.detectSupport(threeRenderer as unknown as THREE.WebGLRenderer)
  resolveKtx2Ready()
}

async function loadMap(path: string | null, srgb: boolean): Promise<THREE.Texture | null> {
  if (!path) return null
  await ktx2Ready
  const tex = await ktx2Loader.loadAsync('/' + encodeURI(path))
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 8
  return tex
}

export const loadSeparatePbrMaterial = async (id: string): Promise<THREE.Material> => {
  const entry = MATERIAL_DOCS[`/inventory/materials/${id}.json`]
  if (!entry) throw new Error(`inventory: no material '${id}'`)
  const doc = (await entry()).default
  const t = doc.tuning

  // await every map before returning: preloading means the material is fully usable the
  // instant the promise resolves — no black-then-textured flash when it enters the scene.
  const [color, normal, roughness, metallic, ao] = await Promise.all([
    loadMap(doc.maps.color, true),
    loadMap(doc.maps.normal, false),
    loadMap(doc.maps.roughness, false),
    loadMap(doc.maps.metallic, false),
    loadMap(doc.maps.ao, false),
  ])

  const mat = new MeshStandardNodeMaterial()
  mat.name = id
  mat.roughness = t.roughness
  mat.metalness = t.metalness
  if (color) mat.map = color
  if (normal) {
    mat.normalMap = normal
    mat.normalScale.set(t.normalScale, t.normalScale)
  }
  if (roughness) mat.roughnessMap = roughness
  if (metallic) mat.metalnessMap = metallic
  if (ao) {
    mat.aoMap = ao
    mat.aoMap.channel = 0 // geometry carries one uv set; AO samples it, not a uv2
    mat.aoMapIntensity = t.aoIntensity
  }
  if (t.doubleSided) mat.side = THREE.DoubleSide
  return mat
}
