// Opt-in environment reflection for the inventory editor.
//
// A material reflects the level env ONLY when it opts in via envMapIntensity > 0
// (surface presets from inventory materials.ts): the PMREM texture is assigned as
// material.envMap, which respects the per-material intensity. Materials that don't
// opt in are lit purely by scene.environment (IBL) with no added reflection.
import * as THREE from 'three'

let envTexture: THREE.Texture | null = null

// the level viewport registers its PMREM RoomEnvironment texture at startup
export function setLevelEnvMap(tex: THREE.Texture | null): void {
  envTexture = tex
}

// current level env (PMREM sky / RoomEnvironment). The water shader reads it
// directly for its fresnel reflection (a ShaderMaterial can't opt in via
// attachEnv's envMapIntensity path). Nullable before the viewport boots.
export function getLevelEnvMap(): THREE.Texture | null {
  return envTexture
}

// give one material its opted-in reflection (no-op for envMapIntensity 0)
export function attachEnv(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial & { isMeshStandardNodeMaterial?: boolean }
  if (!std.isMeshStandardMaterial && !std.isMeshStandardNodeMaterial) return
  // WebGPU: assigning `envMap` to a MeshStandardNodeMaterial builds a PMREMNode that throws
  // "Cannot read properties of null (reading 'isRenderTargetTexture')" during shader build — the whole
  // material then renders BLACK (this only bites materials that opt in, envMapIntensity > 0). The
  // material already reflects the scene's IBL environment (scene.environment) — the Manager preview
  // reflects gorgeously with NO per-material envMap — so opt-in reflection rides scene.environment and
  // we never set the crashing envMap on a node material. (Legacy MeshStandardMaterial still uses envMap.)
  // node materials (and anything flagged iblFromScene — e.g. imported GLB materials) light
  // from the LIVE scene.environment, never a per-material envMap: the latter is a snapshot
  // of the current PMREM env that the next HDRI swap disposes, blacking the material out.
  const sceneIbl = std.isMeshStandardNodeMaterial || std.userData?.iblFromScene === true
  const want = sceneIbl ? null : std.envMapIntensity > 0 ? envTexture : null
  if (std.envMap !== want) {
    std.envMap = want
    std.needsUpdate = true // USE_ENVMAP define changes — recompile
  }
}

// walk freshly built content (instances, vegetation entities) and attach
// reflections to every opted-in material
export function applyEnvReflection(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) attachEnv(m)
  })
}
