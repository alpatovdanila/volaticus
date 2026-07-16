// Glowing-stick projectiles — one InstancedMesh for ALL live bolts (a full volley is a
// single draw call). Each bolt is a thin elongated box, oriented along its velocity,
// unlit + emissive-bright so it reads as energy against the lit scene. Straight-line
// flight, sphere test against targets, hard TTL so strays never leak.
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { color } from 'three/tsl'
import { system } from './system'
import type { LightPool } from './lights'

const BOLT_LIGHT = { color: 0xff9a33, intensity: 7, range: 5 } // warm tracer pool on the PBR floor

const MAX = 64
const SPEED = 16 // m/s
const TTL = 1.2 // s — well past arena scale; hits usually land in ~0.3s
const HIT_RADIUS = 0.38 // m — zombie body hit radius (15% tighter than 0.45 so spread can miss)

export interface Hit {
  target: THREE.Object3D
  at: THREE.Vector3
  dir: THREE.Vector3 // unit travel direction at impact (exit-wound spray goes this way)
}

export interface UpdateResult {
  hits: Hit[]
  walls: THREE.Vector3[] // bolts that ended on the arena wall this frame (spark here)
}

interface Bolt {
  pos: THREE.Vector3
  vel: THREE.Vector3
  quat: THREE.Quaternion
  ttl: number
  light: THREE.PointLight | null // lent from the pool; null when the pool ran dry
}

const _m = new THREE.Matrix4()
const _scale = new THREE.Vector3(1, 1, 1)
const _fwd = new THREE.Vector3(0, 0, 1)

export class Projectiles {
  readonly imesh: THREE.InstancedMesh
  private live: Bolt[] = []

  constructor(
    scene: THREE.Scene,
    private wallHalf = Infinity, // |x|/|z| beyond this = wall impact (reported for sparks)
    private lights: LightPool | null = null, // optional dlights: one pooled light per bolt
  ) {
    const geo = new THREE.BoxGeometry(0.014, 0.014, 0.4) // 50% thinner cross-section
    const mat = new MeshBasicNodeMaterial()
    mat.colorNode = color(2.6, 1.15, 0.18) // >1 channels: hot orange tracer under tone mapping
    this.imesh = new THREE.InstancedMesh(geo, mat, MAX)
    this.imesh.count = 0
    this.imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.imesh.frustumCulled = false
    scene.add(this.imesh)
  }

  spawn(from: THREE.Vector3, dir: THREE.Vector3): void {
    if (this.live.length >= MAX) return // volley cap — oldest bolts finish first
    const aim = dir.clone().normalize()
    // base spread: registry-tunable deviation radius per meter of travel (uniform disc
    // in the plane perpendicular to the aim line — 0.025 ⇒ up to 0.5m off at 20m)
    const spread = system.params.bulletSpread
    if (spread > 0) {
      const side = new THREE.Vector3().crossVectors(aim, new THREE.Vector3(0, 1, 0)).normalize()
      if (side.lengthSq() < 0.5) side.set(1, 0, 0) // aim was vertical — any perpendicular works
      const up = new THREE.Vector3().crossVectors(side, aim)
      const r = spread * Math.sqrt(Math.random())
      const a = Math.random() * Math.PI * 2
      aim.addScaledVector(side, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize()
    }
    const vel = aim.multiplyScalar(SPEED)
    this.live.push({
      pos: from.clone(),
      vel,
      quat: new THREE.Quaternion().setFromUnitVectors(_fwd, vel.clone().normalize()),
      ttl: TTL,
      light: this.lights?.lend(BOLT_LIGHT.color, BOLT_LIGHT.intensity, BOLT_LIGHT.range) ?? null,
    })
  }

  // advance + collide; returns the hits landed this frame. `targets` supplies each
  // candidate's aim point (chest height) — the game layer decides what a target is.
  // Collision is SEGMENT-vs-sphere over the frame's travel (a fast bolt covers more
  // than the hit radius per frame at low fps — a point test tunnels straight through).
  update(dt: number, targets: { object: THREE.Object3D; point: THREE.Vector3 }[]): UpdateResult {
    const hits: Hit[] = []
    const walls: THREE.Vector3[] = []
    const keep: Bolt[] = []
    const seg = new THREE.Vector3()
    const toT = new THREE.Vector3()
    for (const b of this.live) {
      b.ttl -= dt
      seg.copy(b.vel).multiplyScalar(dt)
      const segLen2 = seg.lengthSq()
      let hit: Hit | null = null
      for (const t of targets) {
        toT.copy(t.point).sub(b.pos)
        const u = segLen2 > 0 ? THREE.MathUtils.clamp(toT.dot(seg) / segLen2, 0, 1) : 0
        const dx = toT.x - seg.x * u
        const dy = toT.y - seg.y * u
        const dz = toT.z - seg.z * u
        if (dx * dx + dy * dy + dz * dz < HIT_RADIUS * HIT_RADIUS) {
          hit = { target: t.object, at: b.pos.clone().addScaledVector(seg, u), dir: b.vel.clone().normalize() }
          break
        }
      }
      b.pos.add(seg)
      let dead = true
      if (hit) hits.push(hit)
      else if (Math.abs(b.pos.x) > this.wallHalf || Math.abs(b.pos.z) > this.wallHalf) {
        walls.push(
          b.pos
            .clone()
            .setX(THREE.MathUtils.clamp(b.pos.x, -this.wallHalf, this.wallHalf))
            .setZ(THREE.MathUtils.clamp(b.pos.z, -this.wallHalf, this.wallHalf)),
        )
      } else if (b.ttl > 0) {
        keep.push(b)
        dead = false
        b.light?.position.copy(b.pos) // the dlight rides the tracer
      }
      if (dead && b.light) {
        this.lights?.release(b.light)
        b.light = null
      }
    }
    this.live = keep
    this.imesh.count = keep.length
    for (let i = 0; i < keep.length; i++) {
      this.imesh.setMatrixAt(i, _m.compose(keep[i].pos, keep[i].quat, _scale))
    }
    this.imesh.instanceMatrix.needsUpdate = true
    return { hits, walls }
  }
}
