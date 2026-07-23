// Plays effect docs (inventory/effects/*.json): particle bursts of chunky
// colored cubes or flipbook sprites + a point-light flash + camera shake + sfx.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { getTexture } from './materials'
import { generatePlank } from './procgeom'
import { flipbookFrames, type BurstDef, type EffectDoc } from './schema'

function plankDebrisGeometry(aspect: [number, number, number]): THREE.BufferGeometry {
  const g = generatePlank(aspect[0], aspect[1], aspect[2], 0.3, (Math.random() * 1e9) | 0)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2))
  geo.setIndex(g.indices)
  geo.computeVertexNormals()
  return geo
}

interface Particle {
  pos: THREE.Vector3
  vel: THREE.Vector3
  axis: THREE.Vector3
  spin: number
  angle: number
  size: number
  life: number
  ttl: number
}

interface LiveBurst {
  mesh: THREE.InstancedMesh | null // cube form
  sprites: THREE.Sprite[] | null // flipbook form
  frames: THREE.Texture[] | null
  particles: Particle[]
  def: BurstDef
  delay: number
  started: boolean
  origin: THREE.Vector3
}

interface LiveFlash {
  light: THREE.PointLight
  ttl: number
  life: number
  intensity: number
}

const BOX = new THREE.BoxGeometry(1, 1, 1)
const dummy = new THREE.Object3D()

// ---------------------------------------------------------------------------
// material pools — NEVER disposed. The WebGLRenderer deletes a shader program
// when the last material referencing it is disposed (releaseMaterialProgram-
// References → refcount 0 → deleteProgram), so the old per-burst material
// dispose forced a full re-link on the NEXT spawn — a 2-3s synchronous freeze
// on D3D11/ANGLE, on EVERY effect. Pool entries are few (one per appearance
// key / per source material) and pin their programs alive for the session.

// cube/plank burst material, keyed by inherited texture path + uv rotation.
// It carries no per-burst state (particle colors are instance attributes), so
// concurrent bursts safely share the same instance — no release bookkeeping.
const burstMatPool = new Map<string, THREE.MeshBasicMaterial>()

function acquireBurstMaterial(texture?: string, uvRot?: number): THREE.MeshBasicMaterial {
  const key = `${texture ?? ''}|${uvRot ?? 0}`
  let mat = burstMatPool.get(key)
  if (mat) return mat
  mat = new THREE.MeshBasicMaterial()
  if (texture) {
    let tex = getTexture(texture)
    if (uvRot) {
      // rotated clone — pooled alongside its material: uploaded once per
      // (texture, rot) ever, never disposed (uv rotation is a uniform, so the
      // shader program is shared with every other mapped burst material)
      tex = tex.clone()
      tex.center.set(0.5, 0.5)
      tex.rotation = THREE.MathUtils.degToRad(uvRot)
      tex.needsUpdate = true
    }
    mat.map = tex
  }
  burstMatPool.set(key, mat)
  return mat
}

// flipbook/sprite materials mutate per particle per frame (map / rotation /
// opacity / color), so each live particle needs its own instance — a free
// list, recycled on burst end instead of disposed.
const spriteMatPool: THREE.SpriteMaterial[] = []

function acquireSpriteMaterial(map: THREE.Texture, color: THREE.Color): THREE.SpriteMaterial {
  const mat = spriteMatPool.pop() ?? new THREE.SpriteMaterial({ transparent: true, depthWrite: false })
  mat.map = map
  mat.color.copy(color)
  mat.rotation = 0
  mat.opacity = 1
  return mat
}

function releaseSpriteMaterial(mat: THREE.SpriteMaterial): void {
  spriteMatPool.push(mat)
}

// shatter debris material — ONE pooled clone per source material (keyed by
// uuid): the first shatter of a given entity material creates the clone,
// every later shard/shatter reuses it. Shards never mutate their material
// (fade-out is a scale shrink), so all shards of a source share one clone.
// Source materials are per-entity slot materials, so the pool stays small.
const shatterMatPool = new Map<string, THREE.Material>()

function acquireShatterMaterial(src: THREE.Material): THREE.Material {
  let mat = shatterMatPool.get(src.uuid)
  if (!mat) {
    mat = src.clone()
    shatterMatPool.set(src.uuid, mat)
  }
  return mat
}

// Dominant bone of a skinned part = the bone carrying the most total skin weight. Parts
// worth severing (hands, heads) are ~fully rigid to one bone, so a bake in that bone's
// bind frame reproduces the live pose exactly when re-attached to the bone's world matrix.
function dominantBoneIndex(sm: THREE.SkinnedMesh): number {
  const idx = sm.geometry.attributes.skinIndex as THREE.BufferAttribute | undefined
  const wgt = sm.geometry.attributes.skinWeight as THREE.BufferAttribute | undefined
  if (!idx || !wgt) return -1
  const acc = new Float32Array(sm.skeleton.bones.length)
  for (let i = 0; i < idx.count; i++)
    for (let k = 0; k < 4; k++) {
      const w = wgt.getComponent(i, k)
      if (w > 0) acc[idx.getComponent(i, k)] += w
    }
  let best = -1
  let bw = 0
  for (let b = 0; b < acc.length; b++)
    if (acc[b] > bw) {
      bw = acc[b]
      best = b
    }
  return best
}

// Canonical chunk bake for a pool: the part's geometry expressed in its dominant bone's
// BIND frame (skinned) or its own local frame (plain), RE-CENTRED on its bounding-box
// centre. Centering is the key: a limb sits far from the armature origin, so if the chunk's
// transform were the armature origin, spinning it would swing the limb in a huge arc (it
// "orbits" and dips under the floor). Centred, the instance transform IS the limb's
// location, so it tumbles in place. Every instance of the pool shares this one geometry;
// the spawn matrix places it at the live limb:
//   skinned: meshWorld · bindInv · boneWorld · T(centre)     plain: meshWorld · T(centre)
function bakeCanonicalChunk(mesh: THREE.Mesh): {
  geo: THREE.BufferGeometry
  centre: THREE.Vector3
  size: THREE.Vector3
  boneIndex: number
} {
  const sm = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null
  const geo = mesh.geometry.clone()
  let boneIndex = -1
  if (sm) {
    boneIndex = dominantBoneIndex(sm)
    // bone-local at bind: boneInverse · bindMatrix (applyMatrix4 also fixes normals/tangents)
    if (boneIndex >= 0)
      geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(sm.skeleton.boneInverses[boneIndex], sm.bindMatrix))
  }
  geo.deleteAttribute('skinIndex') // instances are rigid — drop skin attributes
  geo.deleteAttribute('skinWeight')
  geo.computeBoundingBox()
  const box = geo.boundingBox!
  const centre = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  geo.translate(-centre.x, -centre.y, -centre.z)
  return { geo, centre, size, boneIndex }
}

export interface EffectDeps {
  playSfx(id: string): void
  addShake(amount: number): void
}

export interface EffectParams {
  texture?: string // applied to bursts marked "inherit" (debris matches the source object)
  uvRot?: number // texture direction for the inherited texture, degrees (any angle; UI offers 15° steps)
  // world-space bias added to every particle's random unit direction before speed is
  // applied — LENGTH is the strength (1 ≈ hemisphere, 2 ≈ tight cone). Shapes 'sphere'/
  // 'up' only; 'ring' keeps its authored silhouette.
  aim?: THREE.Vector3
}

interface Shard {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  axis: THREE.Vector3
  spin: number
  life: number
  ttl: number
}

// One InstancedMesh per (source geometry, part): every severed copy of that part — across
// ALL live models of the model, whenever they were severed — is one instance slot, so a
// horde's worth of severed hands stays ONE draw call. Canonical geometry is baked once in
// the dominant bone's bind frame, re-centred on its own bbox (a chunk tumbles about its
// own middle); the spawn matrix places it at the live limb.
interface ChunkPool {
  imesh: THREE.InstancedMesh
  geo: THREE.BufferGeometry // canonical bake — owned by the pool (disposed on full clear)
  centre: THREE.Vector3 // canonical bbox centre in bone/local space (spawn offset)
  size: THREE.Vector3 // canonical bbox size — restY at spawn, scaled per instance
  boneIndex: number // dominant bone (−1 = plain mesh)
  cap: number
  slots: DismemberedPart[] // dense: slots[i] owns instance i
}

// A severed limb (dismemberment): one instance slot of its pool + a physics body. Unlike a
// shatter Shard it does NOT despawn: it falls, bounces, settles, and PERSISTS until the host
// clears it. Matrix writes stop once resting — a settled battlefield costs nothing per frame.
interface DismemberedPart {
  pool: ChunkPool
  slot: number // instance index in the pool — kept in sync on swap-removal
  part?: string // source mesh part name — lets the host despawn ONE part's chunks (restore)
  pos: THREE.Vector3
  quat: THREE.Quaternion
  scl: THREE.Vector3
  vel: THREE.Vector3
  axis: THREE.Vector3
  spin: number
  restY: number // center height at which the piece sits on the ground
  resting: boolean
}

const _chunkM = new THREE.Matrix4()
const _spinQ = new THREE.Quaternion()

// Where an effect's `flash` gets its PointLight from. This is a SEAM, not a nicety: adding
// a light to the scene rebuilds every pipeline on this stack (r185 bakes the light COUNT
// into them), which is precisely the hitch — and, under the game's MRT post chain, the
// black-canvas poisoning — that the game's fixed light pools exist to prevent. The editor
// can afford raw lights (it warms the variants up front); the game cannot, and hands over
// a pool instead. `release` returns the light when the flash dies.
export interface FlashLights {
  acquire(color: THREE.ColorRepresentation, intensity: number, range: number): THREE.PointLight | null
  release(light: THREE.PointLight): void
}

// the editor's policy, and the default: a fresh light per flash, added to and removed from
// the scene. Kept as the default so this shared module's existing consumer (the editor) is
// bit-identical — the GAME passes its pool explicitly (see main.ts).
function rawFlashLights(scene: THREE.Scene): FlashLights {
  return {
    acquire: (color, intensity, range) => {
      const l = new THREE.PointLight(color, intensity, range, 1.2)
      scene.add(l)
      return l
    },
    release: (l) => scene.remove(l),
  }
}

export class EffectSystem {
  private bursts: LiveBurst[] = []
  private flashes: LiveFlash[] = []
  private shards: Shard[] = []
  private dismembered: DismemberedPart[] = []
  private chunkPools = new Map<string, ChunkPool>()

  private flashLights: FlashLights

  // `flashLights` defaults to the editor's raw-light policy (unchanged behaviour). Pass a
  // pool-backed provider to keep the scene's light COUNT fixed; pass one whose acquire()
  // always returns null to skip flashes entirely — the doc stays valid either way.
  constructor(
    private scene: THREE.Scene,
    flashLights?: FlashLights,
  ) {
    this.flashLights = flashLights ?? rawFlashLights(scene)
  }

  // Death drama: clone the entity's visible pieces and let them tumble apart.
  shatterMeshes(meshes: THREE.Mesh[]): void {
    const box = new THREE.Box3()
    const visible = meshes.filter((m) => {
      let o: THREE.Object3D | null = m
      while (o) {
        if (!o.visible) return false
        o = o.parent
      }
      return true
    })
    if (!visible.length) return
    for (const m of visible) box.expandByObject(m)
    const center = box.getCenter(new THREE.Vector3())

    for (const src of visible) {
      const srcMat = Array.isArray(src.material) ? src.material[0] : src.material
      const mesh = new THREE.Mesh(src.geometry.clone(), acquireShatterMaterial(srcMat as THREE.Material))
      src.updateWorldMatrix(true, false)
      src.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale)
      this.scene.add(mesh)
      const out = mesh.position.clone().sub(center)
      out.y = 0
      if (out.lengthSq() < 1e-4) out.set(Math.random() - 0.5, 0, Math.random() - 0.5)
      out.normalize()
      this.shards.push({
        mesh,
        vel: out.multiplyScalar(1.2 + Math.random() * 2).add(new THREE.Vector3(0, 2 + Math.random() * 2, 0)),
        axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        spin: 3 + Math.random() * 7,
        life: 0,
        ttl: 0.9 + Math.random() * 0.5,
      })
    }
  }

  // Dismemberment: sever ONE mesh part and let it tumble away. Chunks are INSTANCED — every
  // severed copy of the same (geometry, part), across all models and moments in time, is a
  // slot of one shared InstancedMesh: 100 severed hands = 1 draw call. The pool's canonical
  // geometry is baked once in the part's dominant-bone bind frame; each spawn is placed at
  // THIS entity's live limb via meshWorld · bindInv · boneWorld · T(centre) — exact for
  // single-bone parts (hands, heads); multi-bone parts rigidify to the dominant bone
  // (debris-grade). Plain (boneless) parts use their local frame + world matrix.
  // The caller hides the original part.
  dismemberPart(sm: THREE.Mesh, dir: THREE.Vector3, opts?: { weight?: number; part?: string }): void {
    // chunks accumulate (an entity can lose several parts); the host clears them —
    // the editor does on every rebuild/entity switch, the game via clearDismembered()
    const part = opts?.part ?? (sm.userData.nodeName as string | undefined) ?? sm.name
    const key = `${sm.geometry.uuid}|${part}`
    let pool = this.chunkPools.get(key)
    if (!pool) {
      const { geo, centre, size, boneIndex } = bakeCanonicalChunk(sm)
      const srcMat = Array.isArray(sm.material) ? sm.material[0] : sm.material
      const imesh = new THREE.InstancedMesh(geo, acquireShatterMaterial(srcMat as THREE.Material), 16)
      imesh.count = 0
      imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      imesh.castShadow = true
      imesh.receiveShadow = true
      imesh.frustumCulled = false // instances scatter — a shared bound would cull wrongly
      imesh.userData.dismembered = true // tag so the host can find the debris layer
      this.scene.add(imesh)
      pool = { imesh, geo, centre, size, boneIndex, cap: 16, slots: [] }
      this.chunkPools.set(key, pool)
    }
    if (pool.slots.length === pool.cap) this.growPool(pool)
    // spawn transform: exactly where THIS entity's limb is at this instant
    sm.updateWorldMatrix(true, false)
    const m = new THREE.Matrix4()
    const skinned = (sm as THREE.SkinnedMesh).isSkinnedMesh ? (sm as THREE.SkinnedMesh) : null
    if (skinned && pool.boneIndex >= 0) {
      const bone = skinned.skeleton.bones[pool.boneIndex]
      bone.updateWorldMatrix(true, false)
      m.copy(skinned.matrixWorld).multiply(skinned.bindMatrixInverse).multiply(bone.matrixWorld)
    } else {
      m.copy(sm.matrixWorld)
    }
    m.multiply(new THREE.Matrix4().makeTranslation(pool.centre.x, pool.centre.y, pool.centre.z))
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scl = new THREE.Vector3()
    m.decompose(pos, quat, scl)
    const v = dir.clone().setY(0)
    if (v.lengthSq() < 1e-4) v.set(0, 0, -1)
    v.normalize()
    // weight feel: constant hit impulse → velocity ∝ 1/weight. A light hand flies and
    // tumbles fast; a heavy arm drops short and rolls. Vertical pop is capped so feather
    // parts don't moonshot; all weights share the SAME animation model (tumble → settle).
    const w = Math.max(0.05, opts?.weight ?? 1)
    const kick = THREE.MathUtils.clamp(1 / w, 0.25, 3)
    const rec: DismemberedPart = {
      pool,
      slot: pool.slots.length,
      part,
      pos,
      quat,
      scl,
      // hit-from-front knock-back: mostly horizontal (flies behind), a small pop up → lands + rests
      vel: v
        .multiplyScalar((2.2 + Math.random()) * kick)
        .add(
          new THREE.Vector3((Math.random() - 0.5) * 0.6 * kick, (1.4 + Math.random() * 0.5) * Math.min(kick, 1.6), 0),
        ),
      axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      spin: (7 + Math.random() * 5) * THREE.MathUtils.clamp(1 / w, 0.5, 2.2),
      restY: Math.max(
        0.02,
        Math.min(pool.size.x * Math.abs(scl.x), pool.size.y * Math.abs(scl.y), pool.size.z * Math.abs(scl.z)) / 2,
      ),
      resting: false,
    }
    pool.slots.push(rec)
    pool.imesh.count = pool.slots.length
    pool.imesh.setMatrixAt(rec.slot, m)
    pool.imesh.instanceMatrix.needsUpdate = true
    this.dismembered.push(rec)
  }

  // Double a full pool: fresh InstancedMesh at 2× capacity, matrices copied over — resting
  // chunks carry across untouched. The canonical geometry and pooled material are shared.
  private growPool(pool: ChunkPool): void {
    const old = pool.imesh
    const next = new THREE.InstancedMesh(pool.geo, old.material, pool.cap * 2)
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    next.count = pool.slots.length
    const m = new THREE.Matrix4()
    for (let i = 0; i < pool.slots.length; i++) {
      old.getMatrixAt(i, m)
      next.setMatrixAt(i, m)
    }
    next.castShadow = true
    next.receiveShadow = true
    next.frustumCulled = false
    next.userData.dismembered = true
    this.scene.add(next)
    this.scene.remove(old)
    old.dispose() // instance buffers only — geometry/material shared, kept
    pool.imesh = next
    pool.cap *= 2
  }

  // Remove one chunk from its pool: swap-last keeps the instance range dense.
  private removeChunk(rec: DismemberedPart): void {
    const pool = rec.pool
    const last = pool.slots.pop()
    if (last && last !== rec) {
      pool.slots[rec.slot] = last
      last.slot = rec.slot
      pool.imesh.setMatrixAt(rec.slot, _chunkM.compose(last.pos, last.quat, last.scl))
    }
    pool.imesh.count = pool.slots.length
    pool.imesh.instanceMatrix.needsUpdate = true
  }

  // Budget the battlefield: despawn the OLDEST severed chunks beyond `max` (the live
  // list is in spawn order). Hosts call this per frame with their remains budget.
  capDismembered(max: number): void {
    while (this.dismembered.length > max) this.removeChunk(this.dismembered.shift()!)
  }

  // Despawn severed limbs — all of them, or just one part's chunks (restore/undo a
  // dismemberment: the modifier re-shows the limb, this removes its ground twin). Idempotent.
  clearDismembered(part?: string): void {
    const keep: DismemberedPart[] = []
    for (const p of this.dismembered) {
      if (part !== undefined && p.part !== part) {
        keep.push(p)
        continue
      }
      this.removeChunk(p)
    }
    this.dismembered = keep
    // full clear (editor rebuild / entity switch): drop the pools too — the next sever
    // re-bakes its canonical chunk (cheap, once) against whatever model is loaded then
    if (part === undefined) {
      for (const pool of this.chunkPools.values()) {
        this.scene.remove(pool.imesh)
        pool.imesh.dispose() // instance buffers; material is the pooled shatter clone (kept)
        pool.geo.dispose() // canonical bake — owned by the pool
      }
      this.chunkPools.clear()
    }
  }

  play(doc: EffectDoc, at: THREE.Vector3, deps: EffectDeps, params?: EffectParams): void {
    const sfx = doc.sfx == null ? [] : Array.isArray(doc.sfx) ? doc.sfx : [doc.sfx]
    for (const id of sfx) deps.playSfx(id)
    if (doc.shake) deps.addShake(doc.shake)

    for (const def of doc.particles ?? []) {
      let mesh: THREE.InstancedMesh | null = null
      let sprites: THREE.Sprite[] | null = null
      let frames: THREE.Texture[] | null = null
      if (def.flipbook || def.sprite) {
        frames = def.flipbook ? flipbookFrames(def.flipbook).map((p) => getTexture(p)) : [getTexture(def.sprite!)]
        sprites = []
      } else {
        const mat =
          def.inherit && params?.texture ? acquireBurstMaterial(params.texture, params.uvRot) : acquireBurstMaterial()
        const geo = def.geometry === 'plank' ? plankDebrisGeometry(def.aspect ?? [2.8, 0.5, 0.35]) : BOX
        mesh = new THREE.InstancedMesh(geo, mat, def.count)
        mesh.userData.ownGeometry = def.geometry === 'plank'
        mesh.frustumCulled = false
      }
      const origin = at.clone()
      if (def.offset) origin.add(new THREE.Vector3(...def.offset))
      const particles: Particle[] = []
      for (let i = 0; i < def.count; i++) {
        let dir: THREE.Vector3
        if (def.dir === 'ring') {
          const a = Math.random() * Math.PI * 2
          dir = new THREE.Vector3(Math.cos(a), 0.1 + Math.random() * 0.35, Math.sin(a)).normalize()
        } else {
          dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
          if (dir.lengthSq() < 1e-4) dir = new THREE.Vector3(0, 1, 0)
          dir.normalize()
          if (def.dir === 'up') ((dir.y = Math.abs(dir.y) * 1.5), dir.normalize())
          if (params?.aim) dir.add(params.aim).normalize()
        }
        const speed = def.speed[0] + Math.random() * (def.speed[1] - def.speed[0])
        const ttl = def.life[0] + Math.random() * (def.life[1] - def.life[0])
        particles.push({
          pos: origin.clone(),
          vel: dir.multiplyScalar(speed),
          axis: new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize(),
          spin: (Math.random() * 2 - 1) * (def.spin ?? 0),
          angle: Math.random() * Math.PI * 2,
          size: def.size[0] + Math.random() * (def.size[1] - def.size[0]),
          life: 0,
          ttl,
        })
        const color = new THREE.Color(def.colors[Math.floor(Math.random() * def.colors.length)])
        if (mesh) mesh.setColorAt(i, color)
        if (sprites && frames) {
          const sprite = new THREE.Sprite(acquireSpriteMaterial(frames[0], color))
          sprite.visible = false
          sprites.push(sprite)
        }
      }
      if (mesh?.instanceColor) mesh.instanceColor.needsUpdate = true
      this.bursts.push({ mesh, sprites, frames, particles, def, delay: def.delay ?? 0, started: false, origin })
    }

    if (doc.flash) {
      const intensity = doc.flash.intensity * 30
      const light = this.flashLights.acquire(doc.flash.color, intensity, doc.flash.radius ?? 8)
      if (light) {
        // null = the provider is rationing (pool dry, or flashes disabled). The effect
        // still plays — it just doesn't light the room. Same contract as LightPool.lend.
        light.position.copy(at)
        this.flashes.push({ light, ttl: doc.flash.duration, life: 0, intensity })
      }
    }
  }

  update(dt: number): void {
    for (const b of this.bursts) {
      if (b.delay > 0) {
        b.delay -= dt
        continue
      }
      if (!b.started) {
        b.started = true
        if (b.mesh) this.scene.add(b.mesh)
        if (b.sprites)
          for (const s of b.sprites) {
            s.visible = true
            this.scene.add(s)
          }
      }
      let alive = 0
      for (let i = 0; i < b.particles.length; i++) {
        const p = b.particles[i]
        p.life += dt
        const u = Math.min(1, p.life / p.ttl)
        if (u < 1) alive++
        p.vel.y += (b.def.gravity ?? 0) * dt
        if (b.def.drag) p.vel.multiplyScalar(Math.max(0, 1 - b.def.drag * dt))
        p.pos.addScaledVector(p.vel, dt)
        p.angle += p.spin * dt

        if (b.mesh) {
          const scale = u >= 1 ? 0 : p.size * (b.def.fade === false ? 1 : 1 - u * u)
          const s = Math.max(scale, 0.0001)
          // plank geometry has its aspect baked in; cubes stretch via scale
          const aspect = b.def.geometry === 'plank' ? [1, 1, 1] : (b.def.aspect ?? [1, 1, 1])
          dummy.position.copy(p.pos)
          dummy.quaternion.setFromAxisAngle(p.axis, p.angle)
          dummy.scale.set(s * aspect[0], s * aspect[1], s * aspect[2])
          dummy.updateMatrix()
          b.mesh.setMatrixAt(i, dummy.matrix)
        }
        if (b.sprites && b.frames) {
          const sprite = b.sprites[i]
          const mat = sprite.material as THREE.SpriteMaterial
          if (u >= 1) {
            sprite.visible = false
          } else {
            sprite.position.copy(p.pos)
            mat.map = b.frames[Math.min(b.frames.length - 1, Math.floor(u * b.frames.length))]
            mat.rotation = p.angle
            mat.opacity = b.def.fade === false ? 1 : 1 - u * u
            const s = p.size * (1 + ((b.def.grow ?? 1) - 1) * u)
            sprite.scale.set(s, s, 1)
          }
        }
      }
      if (b.mesh) b.mesh.instanceMatrix.needsUpdate = true
      if (alive === 0) {
        if (b.mesh) {
          this.scene.remove(b.mesh)
          b.mesh.dispose() // instance attribute buffers only — no program lives here
          if (b.mesh.userData.ownGeometry) b.mesh.geometry.dispose() // unique plank buffers
          // material (+ any rotated-texture clone) is pooled — NEVER disposed:
          // disposing would delete its shader program and the next spawn would
          // re-link it synchronously (the 2-3s ANGLE freeze this fixes)
        }
        if (b.sprites)
          for (const s of b.sprites) {
            this.scene.remove(s)
            releaseSpriteMaterial(s.material) // recycled, never disposed
          }
        b.particles.length = 0
      }
    }
    this.bursts = this.bursts.filter((b) => b.delay > 0 || b.particles.length > 0)

    for (const f of this.flashes) {
      f.life += dt
      const u = Math.min(1, f.life / f.ttl)
      f.light.intensity = f.intensity * (1 - u) * (1 - u)
      if (u >= 1) this.flashLights.release(f.light) // back to the provider (scene remove, or pool)
    }
    this.flashes = this.flashes.filter((f) => f.life < f.ttl)

    for (const s of this.shards) {
      s.life += dt
      const u = Math.min(1, s.life / s.ttl)
      s.vel.y -= 9.8 * dt
      s.mesh.position.addScaledVector(s.vel, dt)
      s.mesh.rotateOnAxis(s.axis, s.spin * dt)
      if (u > 0.7) {
        const k = 1 - (u - 0.7) / 0.3
        s.mesh.scale.multiplyScalar(Math.max(0.001, Math.pow(k, 0.15)))
      }
      if (u >= 1) {
        this.scene.remove(s.mesh)
        s.mesh.geometry.dispose() // per-shard geometry clone — buffers only, programs unaffected
        // material is the pooled shatter clone — never disposed (see shatterMatPool)
      }
    }
    this.shards = this.shards.filter((s) => s.life < s.ttl)

    // Severed limbs: fall + tumble with WEIGHT — over-g gravity (real 9.8 reads floaty at this
    // visual scale), then energy-losing bounces with ground friction and tumble decay before
    // coming to rest. PERSISTS after settling (no despawn — clearDismembered() is the host's).
    const dirtyPools = new Set<ChunkPool>()
    for (const p of this.dismembered) {
      if (p.resting) continue
      p.vel.y -= 14 * dt
      p.pos.addScaledVector(p.vel, dt)
      p.quat.multiply(_spinQ.setFromAxisAngle(p.axis, p.spin * dt)) // local-axis tumble
      if (p.pos.y <= p.restY && p.vel.y <= 0) {
        p.pos.y = p.restY
        if (-p.vel.y > 1.1) {
          // hard contact → bounce: restitution robs most of the fall, friction bleeds the
          // slide, and the tumble slows with every touch — the mass is in the decay.
          p.vel.y = -p.vel.y * 0.35
          p.vel.x *= 0.55
          p.vel.z *= 0.55
          p.spin *= 0.5
        } else {
          // too slow to bounce — settle where it lies
          p.vel.set(0, 0, 0)
          p.spin = 0
          p.resting = true // keeps its instance slot until clearDismembered()
        }
      }
      p.pool.imesh.setMatrixAt(p.slot, _chunkM.compose(p.pos, p.quat, p.scl))
      dirtyPools.add(p.pool)
    }
    for (const pool of dirtyPools) pool.imesh.instanceMatrix.needsUpdate = true
  }
}

// ---------------------------------------------------------------------------
// boot warmup — compile every program an effect spawn can demand BEFORE play.
// Instantiates each doc's visuals through the SAME pooled-material path a real
// spawn uses (so the pools get populated), parks them in a far-away group in
// the live scene, and renderer.compileAsync()s. The pooled materials then keep
// those programs alive for the whole session. A flash adds a PointLight to the
// scene, which changes the renderer's lights hash and re-keys EVERY lit
// material — so the compile also runs with one and with two temporary point
// lights (flash lifetimes can overlap on explode→died chains); without that,
// the first flash after boot would still trigger a scene-wide re-link.

const WARM_MAP_KEY = '__warm-map|0'

export async function warmEffects(
  renderer: WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  docs: EffectDoc[],
  // meshes that may shatter later (player / enemies / studio selection) —
  // pre-clones their materials into the shatter pool so the first death of
  // each links nothing. Same first-material rule as shatterMeshes.
  shatterSources: THREE.Mesh[] = [],
): Promise<void> {
  const group = new THREE.Group()
  // kept VISIBLE (compile gathers lights via traverseVisible) but parked far
  // below the world — frustum culling keeps it off screen if a frame renders
  // while the async compile is in flight.
  group.position.set(0, -5000, 0)

  let hasFlash = false
  let hasCube = false
  let hasInherit = false
  let spriteTex: THREE.Texture | null = null
  for (const doc of docs) {
    if (doc.flash) hasFlash = true
    for (const def of doc.particles ?? []) {
      if (def.flipbook || def.sprite) {
        // start fetching EVERY frame now (decode off the spawn path); one
        // sprite covers the program — SpriteMaterial's key doesn't vary per map
        const paths = def.flipbook ? flipbookFrames(def.flipbook) : [def.sprite!]
        for (const p of paths) {
          const t = getTexture(p)
          if (!spriteTex) spriteTex = t
        }
      } else {
        hasCube = true
        if (def.inherit) hasInherit = true
      }
    }
  }

  const warmSpriteMats: THREE.SpriteMaterial[] = []
  if (spriteTex) {
    const mat = acquireSpriteMaterial(spriteTex, new THREE.Color('#ffffff'))
    warmSpriteMats.push(mat)
    group.add(new THREE.Sprite(mat))
  }
  // instanced cube/plank bursts: the warm mesh must be an InstancedMesh WITH an
  // instance color buffer — USE_INSTANCING / USE_INSTANCING_COLOR are part of
  // the program key, so a plain Mesh would compile the wrong variant.
  const warmInstanced = (mat: THREE.MeshBasicMaterial): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(BOX, mat, 1)
    mesh.setColorAt(0, new THREE.Color('#ffffff'))
    return mesh
  }
  if (hasCube) group.add(warmInstanced(acquireBurstMaterial()))
  if (hasInherit) {
    // inherit bursts carry a per-entity texture unknown at boot, but the
    // program only depends on map PRESENCE — a pooled 1×1 stand-in material
    // keeps the mapped variant linked forever.
    let mat = burstMatPool.get(WARM_MAP_KEY)
    if (!mat) {
      const px = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
      px.colorSpace = THREE.SRGBColorSpace // match getTexture color maps
      px.needsUpdate = true
      mat = new THREE.MeshBasicMaterial({ map: px })
      burstMatPool.set(WARM_MAP_KEY, mat)
    }
    group.add(warmInstanced(mat))
  }

  const seen = new Set<string>()
  for (const src of shatterSources) {
    const srcMat = (Array.isArray(src.material) ? src.material[0] : src.material) as THREE.Material | undefined
    if (!srcMat || seen.has(srcMat.uuid)) continue
    seen.add(srcMat.uuid)
    group.add(new THREE.Mesh(BOX, acquireShatterMaterial(srcMat)))
  }

  scene.add(group)
  const compile = async (): Promise<void> => {
    try {
      await renderer.compileAsync(scene, camera)
    } catch {
      renderer.compile(scene, camera)
    }
  }
  try {
    await compile() // baseline lights (covers shards/bursts alive after a flash fades)
    if (hasFlash) {
      group.add(new THREE.PointLight('#ffffff', 0.0001, 0.1, 2))
      await compile() // every lit material's "+1 point light" variant
      group.add(new THREE.PointLight('#ffffff', 0.0001, 0.1, 2))
      await compile() // "+2" — overlapping flashes (explode + died within a flash ttl)
    }
  } finally {
    scene.remove(group)
    for (const mat of warmSpriteMats) releaseSpriteMaterial(mat)
    group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose() // instance buffers only
    })
  }
}
