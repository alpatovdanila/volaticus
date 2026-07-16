// Glowing arena orbs — a handful of STATIC warm point lights (plus a visible glowing
// sphere each) scattered on the ground so the level reads as lit even with no zombies
// and no gunfire around. This is LEVEL dressing, not a dynamic pool: the lights are
// created once at boot (before the first render, so the scene's light COUNT is fixed and
// no pipeline ever recompiles) and never move. Intensity is LEVEL data (level.ts), tuned
// live from the lighting panel — deliberately NOT in the gameplay registry.
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { color, uniform } from 'three/tsl'

export interface OrbConfig {
  count: number
  color: string // warm hex; drives both the point light and the sphere glow
  intensity: number // point-light intensity (live-tunable)
  radius: number // ring radius from arena centre
  height: number // y of the orb + its light
}

export class Orbs {
  private lights: THREE.PointLight[] = []
  private glowU = uniform(1) // sphere brightness — tracks intensity so the orb visibly dims/brightens
  private mesh: THREE.InstancedMesh

  constructor(scene: THREE.Scene, private cfg: OrbConfig) {
    const col = new THREE.Color(cfg.color)
    const mat = new MeshBasicNodeMaterial() // unlit: the orb always glows, regardless of scene light
    mat.colorNode = color(col).mul(this.glowU)
    const geo = new THREE.SphereGeometry(0.12, 16, 12)
    this.mesh = new THREE.InstancedMesh(geo, mat, cfg.count) // all orb spheres = one draw call
    this.mesh.frustumCulled = false
    const m = new THREE.Matrix4()
    for (let i = 0; i < cfg.count; i++) {
      // even ring, offset so none sits dead-centre where the player/horde fight
      const a = (i / cfg.count) * Math.PI * 2 - Math.PI / 2
      const x = Math.cos(a) * cfg.radius
      const z = Math.sin(a) * cfg.radius
      const light = new THREE.PointLight(col.getHex(), cfg.intensity, 14, 1.6) // warm, wide, gentle falloff, no shadow
      light.position.set(x, cfg.height, z)
      light.castShadow = false
      scene.add(light)
      this.lights.push(light)
      this.mesh.setMatrixAt(i, m.makeTranslation(x, cfg.height, z))
    }
    this.mesh.instanceMatrix.needsUpdate = true
    scene.add(this.mesh)
    this.setIntensity(cfg.intensity)
  }

  // live control from the lighting (level) panel — drives every orb light + the glow
  setIntensity(v: number): void {
    this.cfg.intensity = v
    for (const l of this.lights) l.intensity = v
    this.glowU.value = 0.5 + v * 0.12 // keep the orb visible even when the fill light is low
  }
}
