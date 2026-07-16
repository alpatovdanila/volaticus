// Dynamic light pool — Quake-2-style dlights, the alterro recipe verified on this
// WebGPU stack: a FIXED set of PointLights allocated once at boot (the scene's light
// COUNT must never change — adding/removing a light rebuilds every pipeline), then
// position/intensity/color are all LIVE uniforms (empirically proven on r185 WebGPU;
// only Ambient/Directional intensity was inert in the earlier saga). "Off" = intensity
// 0 + parked under the floor. lend() returns null when the pool is dry — callers must
// degrade gracefully (an unlit tracer still reads fine; rationing beats overflowing).
// None of these lights cast shadows: every pooled light costs per-fragment math on all
// lit pixels even while parked, so the pool stays SMALL.
import * as THREE from 'three'

const PARK_Y = -50

export class LightPool {
  private lights: THREE.PointLight[] = []
  private free: THREE.PointLight[] = []

  // create BEFORE the first render so the initial pipeline compile already includes
  // the full light set — no recompile hitch ever after
  constructor(scene: THREE.Scene, size = 6) {
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 6, 1.8)
      l.position.set(0, PARK_Y, 0)
      l.castShadow = false
      scene.add(l)
      this.lights.push(l)
      this.free.push(l)
    }
  }

  lend(color: number, intensity: number, range: number): THREE.PointLight | null {
    const l = this.free.pop()
    if (!l) return null // dry — the effect goes unlit rather than growing the set
    l.color.set(color)
    l.intensity = intensity
    l.distance = range
    return l
  }

  release(l: THREE.PointLight | null): void {
    if (!l) return
    l.intensity = 0
    l.position.set(0, PARK_Y, 0)
    this.free.push(l)
  }

  stats(): { used: number; size: number } {
    return { used: this.lights.length - this.free.length, size: this.lights.length }
  }
}
