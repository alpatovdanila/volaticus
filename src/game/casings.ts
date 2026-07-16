// Shell casings — every shot flings a glowing hot-red casing from the gun. It tumbles under
// gravity, and the instant it hits the floor it fades out fast (glow + size → 0) and is
// gone — no lingering floor litter. Every live casing is a slot of ONE InstancedMesh (a
// single draw call); per-instance colour carries the red-hot glow.
import * as THREE from 'three'

const MAX = 64 // safety cap on live casings (they clear fast, so this is rarely near)
const GRAVITY = -13
const LAND_FADE = 0.2 // s to fully fade out after hitting the ground — almost immediate
const REST_Y = 0.012 // a casing lying on its side rests this high (its radius)
const HOT = new THREE.Color(3.6, 0.35, 0.1) // glowing hot red (>1 red channel blooms under tonemapping)

interface Casing {
  pos: THREE.Vector3
  vel: THREE.Vector3
  quat: THREE.Quaternion
  spinAxis: THREE.Vector3
  spinRate: number
  glow: number // 1 hot → 0 cold
  landed: boolean
}

export class Casings {
  private imesh: THREE.InstancedMesh
  private list: Casing[] = []
  private dirty = false // spawn/evict changed the set even if nothing is moving
  private _m = new THREE.Matrix4()
  private _s = new THREE.Vector3(1, 1, 1)
  private _dq = new THREE.Quaternion()
  private _col = new THREE.Color()
  private _e = new THREE.Euler()

  constructor(scene: THREE.Scene) {
    const geo = new THREE.CylinderGeometry(0.012, 0.014, 0.05, 6) // tiny tapered shell, low-poly
    const mat = new THREE.MeshBasicMaterial() // unlit; the per-instance colour IS the glow
    this.imesh = new THREE.InstancedMesh(geo, mat, MAX)
    this.imesh.count = 0
    this.imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.imesh.frustumCulled = false
    scene.add(this.imesh)
  }

  // fling a hot casing from the gun: out to the shooter's right + up, tumbling as it flies
  eject(at: THREE.Vector3, aim: THREE.Vector3): void {
    if (this.list.length >= MAX) this.list.shift() // evict the oldest (settled) casing
    const a = aim.clone().setY(0)
    if (a.lengthSq() < 1e-6) a.set(0, 0, 1)
    a.normalize()
    const right = new THREE.Vector3(-a.z, 0, a.x) // shooter's right (model forward = +Z → right is −X)
    const vel = right
      .multiplyScalar(0.9 + Math.random() * 0.6)
      .add(new THREE.Vector3(0, 1.9 + Math.random() * 0.7, 0))
      .addScaledVector(a, -(0.2 + Math.random() * 0.3)) // a touch backward
    this.list.push({
      pos: at.clone(),
      vel,
      quat: new THREE.Quaternion().random(),
      spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      spinRate: 12 + Math.random() * 16,
      glow: 1,
      landed: false,
    })
    this.dirty = true
  }

  update(dt: number): void {
    let active = false
    const keep: Casing[] = []
    for (const c of this.list) {
      if (!c.landed) {
        c.vel.y += GRAVITY * dt
        c.pos.addScaledVector(c.vel, dt)
        this._dq.setFromAxisAngle(c.spinAxis, c.spinRate * dt)
        c.quat.multiply(this._dq)
        if (c.pos.y <= REST_Y) {
          c.pos.y = REST_Y
          c.landed = true
          c.quat.setFromEuler(this._e.set(Math.PI / 2, Math.atan2(c.vel.x, c.vel.z), 0)) // lie flat on its side
        }
        active = true // moving → needs a rebuild
        keep.push(c)
      } else {
        // landed: fade glow + size to nothing fast, then drop the casing (no floor litter)
        c.glow -= dt / LAND_FADE
        if (c.glow > 0) {
          keep.push(c)
          active = true // still fading → needs a rebuild
        } // else fully faded → not kept (removed)
      }
    }
    if (keep.length !== this.list.length) this.dirty = true // a casing dropped → rebuild
    this.list = keep
    if (!active && !this.dirty) return
    this.dirty = false
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i]
      const s = c.landed ? c.glow : 1 // shrink away as it fades out
      this._s.set(s, s, s)
      this.imesh.setMatrixAt(i, this._m.compose(c.pos, c.quat, this._s))
      this.imesh.setColorAt(i, this._col.copy(HOT).multiplyScalar(c.landed ? c.glow : 1))
    }
    this.imesh.count = this.list.length
    this.imesh.instanceMatrix.needsUpdate = true
    if (this.imesh.instanceColor) this.imesh.instanceColor.needsUpdate = true
  }
}
