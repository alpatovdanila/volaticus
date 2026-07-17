// Corpse batch — the cheap, persistent resting place for the dead. A live zombie is an
// animated SkinnedMesh (4 draw calls, CPU skinning); keeping dozens of those lying around
// is exactly the draw-call blowup we want to avoid. So the instant a death animation
// finishes, the corpse is BAKED — its final frozen pose is snapshotted into static
// geometry (once, in the entity's local frame, since every zombie ends the death clip in
// the same pose) — and every corpse thereafter is just an INSTANCE of that geometry. All
// corpses of a part share one InstancedMesh: N dead zombies = 4 draw calls, not 4·N. The
// skinned entity is freed back to the spawn pool the same moment, so it costs nothing more.
//
// Dismemberment is handled per part: a corpse's severed hand simply isn't given an instance
// in that hand's mesh (severed parts are hidden on the source, so they're skipped at bake).
//
// MULTI-TYPE: everything here is keyed by "<type>/<part>". Two species have different
// skeletons, different death poses and different skins, so they must never share a baked
// geometry or an InstancedMesh — an unkeyed batch would wear the first species that died
// as its permanent costume. A type only allocates when its first corpse lands.
import * as THREE from 'three'
import type { BuiltEntity } from '../inventory/factory'

const CAPACITY = 320 // hard ceiling on batched corpses; oldest drop out beyond it

interface Corpse {
  matrix: THREE.Matrix4 // the entity's world transform, frozen at death
  parts: Set<string> // "<type>/<part>" keys this corpse still has (missing = dismembered)
  gen: number // wave it died in (for the HUD / future policy)
}

export class CorpseBatch {
  private parts = new Map<string, THREE.InstancedMesh>() // "<type>/<part>" → shared instanced mesh
  private materials = new Map<string, THREE.Material>() // type → its static skin (captured from the body)
  private corpses: Corpse[] = []
  private dirty = false

  constructor(private scene: THREE.Scene) {}

  // snapshot a SkinnedMesh's CURRENT pose into static group-local geometry. applyBoneTransform
  // gives the skinned vertex in the mesh's local frame; ·matrixWorld → world; ·groupInv →
  // the entity's local frame, so one bake serves every corpse (each instanced by its own
  // world transform). Normals are recomputed from the baked positions (corpse-grade).
  private bake(sm: THREE.SkinnedMesh, groupInv: THREE.Matrix4): THREE.BufferGeometry {
    sm.updateWorldMatrix(true, false)
    const toLocal = new THREE.Matrix4().multiplyMatrices(groupInv, sm.matrixWorld)
    const src = sm.geometry
    const posAttr = src.attributes.position
    const n = posAttr.count
    const out = new Float32Array(n * 3)
    const v = new THREE.Vector3()
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(posAttr, i)
      sm.applyBoneTransform(i, v) // → mesh-local skinned position
      v.applyMatrix4(toLocal) // → entity-group-local
      out[i * 3] = v.x
      out[i * 3 + 1] = v.y
      out[i * 3 + 2] = v.z
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(out, 3))
    if (src.attributes.uv) g.setAttribute('uv', (src.attributes.uv as THREE.BufferAttribute).clone())
    if (src.index) g.setIndex(src.index.clone())
    g.computeVertexNormals()
    return g
  }

  private ensurePart(key: string, mat: THREE.Material, sm: THREE.SkinnedMesh, groupInv: THREE.Matrix4): THREE.InstancedMesh {
    let imesh = this.parts.get(key)
    if (imesh) return imesh
    const geo = this.bake(sm, groupInv)
    imesh = new THREE.InstancedMesh(geo, mat, CAPACITY)
    imesh.count = 0
    imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    imesh.frustumCulled = false // corpses scatter — a shared bound would cull wrongly
    imesh.receiveShadow = true
    imesh.castShadow = false // grounded + low; skip the shadow-pass cost of hundreds of them
    this.scene.add(imesh)
    this.parts.set(key, imesh)
    return imesh
  }

  // the static skin for a species = a CLONE of its BODY material, taken at its first death.
  // A clone, not the live reference: the source belongs to a pooled entity that gets
  // re-dressed forever, so any runtime mutation on it (a hit flash, a status tint) would
  // otherwise restyle every corpse already on the ground, retroactively. This copy is
  // batch-owned and lives as long as the batch — no crystal glow either (that emissive
  // clone stays with the live entity; a corpse's crystals faded long ago).
  private materialFor(type: string, built: BuiltEntity): THREE.Material {
    let mat = this.materials.get(type)
    if (mat) return mat
    const body = built.meshes.find((m) => m.userData.nodeName === 'body') ?? built.meshes[0]
    const src = (Array.isArray(body.material) ? body.material[0] : body.material) as THREE.Material
    mat = src.clone()
    this.materials.set(type, mat)
    return mat
  }

  // enrol a freshly-finished corpse: bake any part geometry we don't have yet, then record
  // this corpse's transform. `built` is about to be recycled, so we copy what we need now.
  add(built: BuiltEntity, type: string, gen: number): void {
    built.group.updateWorldMatrix(true, false)
    const groupInv = built.group.matrixWorld.clone().invert()
    const mat = this.materialFor(type, built)
    const present = new Set<string>()
    for (const sm of built.meshes as THREE.SkinnedMesh[]) {
      if (!sm.visible) continue // severed/hidden parts aren't part of the corpse
      const key = `${type}/${(sm.userData.nodeName as string) || sm.name}`
      this.ensurePart(key, mat, sm, groupInv)
      present.add(key)
    }
    this.corpses.push({ matrix: built.group.matrixWorld.clone(), parts: present, gen })
    if (this.corpses.length > CAPACITY) this.corpses.shift() // evict the oldest corpse
    this.dirty = true
  }

  // rewrite the instance buffers from the surviving corpse records (corpses never move, so
  // this only runs when the set changed). Each part mesh gets an instance for every corpse
  // that still has that part — a corpse of another species simply never holds that key.
  update(): void {
    if (!this.dirty) return
    this.dirty = false
    for (const [key, imesh] of this.parts) {
      let count = 0
      for (const c of this.corpses) {
        if (c.parts.has(key)) {
          imesh.setMatrixAt(count, c.matrix)
          count++
        }
      }
      imesh.count = count
      imesh.instanceMatrix.needsUpdate = true
    }
  }

  count(): number {
    return this.corpses.length
  }

  // empty the battlefield (a new room, a new run). The baked geometry and the per-type
  // materials are KEPT: they're this batch's own, they're what makes a corpse cheap, and
  // the next room's dead will want exactly the same ones. Only the bodies go.
  clear(): void {
    this.corpses.length = 0
    this.dirty = true
    this.update()
  }
}
