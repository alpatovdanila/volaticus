// Shared sky_22 cubemap loader for the editor. Both the material-preview scene
// (matpreview.ts) and the MAIN entity viewport (viewport.ts) use the SAME loaded
// cube texture as their scene.background — a single decode, one GPU upload.
//
// r178 WYSIWYG rule: this texture may be set as scene.BACKGROUND anywhere, but
// NEVER as the entity scene's scene.environment (that floods every material with
// IBL and breaks true color). Opt-in reflection is fed through envmap.ts, which
// only attaches an envMap where envMapIntensity > 0.
import * as THREE from 'three'

// 6-face cubemap under the resources publicDir (see #11 / #28).
export const SKYBOX_DIR = 'skybox/sky_22_2k/sky_22_cubemap_2k'

// three.js CubeTextureLoader face order: [px, nx, py, ny, pz, nz].
const FACES = ['px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png']

let shared: THREE.CubeTexture | null = null

// Load (once) the sky_22 cubemap. Returns the same CubeTexture on every call so
// the background and the reflection env share a single upload. `onLoad` fires
// after the faces decode (used to nudge a render in a stalled preview tab).
export function loadSkybox(onLoad?: (tex: THREE.CubeTexture) => void): THREE.CubeTexture {
  if (shared) {
    if (shared.image && onLoad) onLoad(shared)
    return shared
  }
  shared = loadSkyboxDir(SKYBOX_DIR, onLoad)
  return shared
}

// C1 — load a NAMED skybox by its cubemap directory (the folder holding the six
// px/nx/py/ny/pz/nz face PNGs), resources-relative (e.g.
// "skybox/sky_22_2k/sky_22_cubemap_2k"). Each distinct dir is cached so a
// re-selection reuses the upload; `onLoad` fires once the faces decode. Used by
// the level editor's skybox selector.
const dirCache = new Map<string, THREE.CubeTexture>()

export function loadSkyboxDir(cubemapDir: string, onLoad?: (tex: THREE.CubeTexture) => void): THREE.CubeTexture {
  const cached = dirCache.get(cubemapDir)
  if (cached) {
    if (cached.image && onLoad) onLoad(cached)
    return cached
  }
  const loader = new THREE.CubeTextureLoader()
  loader.setPath('/' + cubemapDir.replace(/\/$/, '') + '/')
  const tex = loader.load(FACES, () => onLoad?.(tex))
  tex.colorSpace = THREE.SRGBColorSpace
  dirCache.set(cubemapDir, tex)
  return tex
}
