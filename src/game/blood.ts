// Blood splatters — reflective floor decals sprayed by hits and left as pools by the
// dead. All splats are ONE InstancedMesh (a single draw call) of flat quads lying on the
// floor. The "wet" look is physically-based, not faked: a low-roughness clearcoat surface
// mirrors the scene environment (the HDRI IBL) + the warm orbs and crystal lights, so a
// fresh pool catches and reflects the light exactly like real blood. Growth (spread-in)
// and eviction (fade-out) are driven by scale; the set is budget-capped, oldest-first.
import * as THREE from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import { texture } from 'three/tsl'

const MAX_SPLATS = 240 // 3× — a battlefield that stays soaked
const GROW = 0.35 // s to spread to full size
const FADE = 0.7 // s to shrink away when evicted
const UP = new THREE.Vector3(0, 1, 0)

interface Splat {
  x: number
  z: number
  rot: number
  size: number
  age: number
  big: boolean // death pool (kept longer) vs a small hit splatter (evicted first)
  fading: boolean
  fadeT: number
}

// a procedural blood-splat alpha mask (RGB white, A = coverage): a lumpy central mass
// with a scatter of satellite droplets. One mask + per-instance random rotation/scale is
// plenty of variety for decals this small; no texture asset to ship.
function makeSplatTexture(): THREE.CanvasTexture {
  const s = 256
  const c = document.createElement('canvas')
  c.width = c.height = s
  const ctx = c.getContext('2d')!
  const cx = s / 2
  const cy = s / 2
  const blob = (x: number, y: number, r: number, a: number): void => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(255,255,255,${a})`)
    g.addColorStop(0.65, `rgba(255,255,255,${a * 0.75})`)
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  // central mass — several overlapping lobes for an irregular edge
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2
    const d = Math.random() * 38
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 42 + Math.random() * 40, 0.92)
  }
  // satellite droplets flung out around it
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2
    const d = 70 + Math.random() * 52
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 4 + Math.random() * 11, 0.85)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 4
  return tex
}

export class BloodSplatters {
  private mesh: THREE.InstancedMesh
  private splats: Splat[] = []
  private _m = new THREE.Matrix4()
  private _q = new THREE.Quaternion()
  private _p = new THREE.Vector3()
  private _s = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1)
    geo.rotateX(-Math.PI / 2) // lie flat on the floor, normal = +Y
    const mat = new MeshPhysicalNodeMaterial()
    mat.color = new THREE.Color('#3c0808') // dark venous red; the reflection supplies the highlight
    mat.roughness = 0.16 // low → sharp-ish env reflection = wet sheen
    mat.metalness = 0
    mat.clearcoat = 1 // varnished second specular lobe — the "fresh/glossy" look
    mat.clearcoatRoughness = 0.1
    mat.transparent = true
    mat.depthWrite = false // decals blend over the floor; no depth write (no z-fight between them)
    mat.opacityNode = texture(mat.userData.splatTex ?? (mat.userData.splatTex = makeSplatTexture())).a
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_SPLATS)
    this.mesh.count = 0
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1 // after the opaque floor
    scene.add(this.mesh)
  }

  // lay a splat on the floor at (x,z). `dir` (bolt travel) orients the splash; `size` is
  // the full diameter in meters; `big` marks a death pool. Over budget the oldest small
  // splatter fades first (death pools linger — they're the reflective centerpiece).
  splat(x: number, z: number, size: number, dir?: THREE.Vector3, big = false): void {
    if (this.splats.length >= MAX_SPLATS) {
      const victim = this.splats.find((s) => !s.fading && !s.big) ?? this.splats.find((s) => !s.fading)
      if (victim) {
        victim.fading = true
        victim.fadeT = 0
      }
    }
    let rot = Math.random() * Math.PI * 2
    if (dir && (dir.x || dir.z)) rot = Math.atan2(dir.x, dir.z) + (Math.random() - 0.5) * 0.6
    this.splats.push({ x, z, rot, size, age: 0, big, fading: false, fadeT: 0 })
  }

  update(dt: number): void {
    const keep: Splat[] = []
    let i = 0
    for (const s of this.splats) {
      s.age += dt
      let scale = Math.min(1, s.age / GROW)
      scale = scale * scale * (3 - 2 * scale) // smoothstep spread-in
      if (s.fading) {
        s.fadeT += dt
        if (s.fadeT >= FADE) continue // fully gone — drop it
        const f = 1 - s.fadeT / FADE
        scale *= f * f
      }
      if (i < MAX_SPLATS) {
        this._p.set(s.x, 0.02, s.z)
        this._q.setFromAxisAngle(UP, s.rot)
        this._s.set(s.size * scale, 1, s.size * scale)
        this.mesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._s))
        i++
      }
      keep.push(s)
    }
    this.splats = keep
    this.mesh.count = i
    this.mesh.instanceMatrix.needsUpdate = true
  }

  count(): number {
    return this.splats.length
  }
}
