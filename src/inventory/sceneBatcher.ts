// SceneBatcher — the cross-entity draw-call collapser. Given a set of built entities +
// their world placements, it runs the shared merge (computeMergeBuckets) on each, then
// pools every (frame, material) bucket ACROSS ALL entities into one THREE.BatchedMesh
// per distinct materialKey. Draw calls for the whole scene = distinct-material count,
// independent of entity count (a 44-entity lineup of ~1500 primitive draws collapses to
// a few dozen batches).
//
// Stage 1 (merge) freezes each entity's same-material geometry into one blob per
// (frame, material) in ENTITY-LOCAL space. Stage 2 (here) adds each blob to its
// material's batch as one instance whose matrix carries the world placement:
//   • static bucket  → instance matrix = placement            (set once)
//   • frame  bucket  → instance matrix = placement · frameNode.inner.matrixWorld
//                      (re-pushed every frame from the animation sim graph)
// Visibility toggles (state show/hide) map to BatchedMesh.setVisibleAt on the frame
// instance. Per-instance frustum culling is available via perObjectFrustumCulled.
import * as THREE from 'three'
import { computeMergeBuckets, materialKey, type MergeBucket } from './merge'
import type { BuiltEntity, BuiltNode } from './factory'
import type { EntityMaterial } from './materials'
import type { EntityDoc } from './schema'

// one entity to place into the batch. The built.group stays at the origin — the world
// placement lives ONLY in the per-instance matrices, so the merge's entity-local blobs
// compose cleanly with animation (which mutates the group's node transforms).
export interface BatchInput {
  built: BuiltEntity
  doc: EntityDoc
  id: string // entity id (for pick results)
  placement: THREE.Matrix4
}

interface Instance {
  batch: THREE.BatchedMesh
  id: number // instance id within the batch
  frame: BuiltNode | null // null = static (matrix set once); else drives per-frame matrix + visibility
  placement: THREE.Matrix4
  built: BuiltEntity
  entityId: string
  node: string // frame node name, or '' for a static bucket
  slotRanges: MergeBucket['slotRanges']
}

function visibleInTree(o: THREE.Object3D): boolean {
  let c: THREE.Object3D | null = o
  while (c) {
    if (!c.visible) return false
    c = c.parent
  }
  return true
}

const _m = new THREE.Matrix4()

export class SceneBatcher {
  readonly group = new THREE.Group() // add to a scene; holds every BatchedMesh
  readonly batches = new Map<string, THREE.BatchedMesh>() // materialKey → batch (one draw call each)
  private instances: Instance[] = []
  private animated: Instance[] = [] // subset needing per-frame setMatrixAt / setVisibleAt
  private animatedEntities: BuiltEntity[] = [] // entities owning ≥1 animated instance

  constructor() {
    this.group.name = 'scene-batcher'
  }

  // Build all batches from the given entities. One-shot: call dispose() then build()
  // again to rebuild (the preview does this on every edit; the lineup once on enter).
  build(inputs: BatchInput[]): void {
    interface Group {
      mat: EntityMaterial
      items: { bucket: MergeBucket; input: BatchInput }[]
      verts: number
    }
    // 1. bucket every entity; group buckets across entities by materialKey; sum sizes.
    const groups = new Map<string, Group>()
    for (const input of inputs) {
      const { buckets } = computeMergeBuckets(input.built, input.doc)
      for (const bucket of buckets) {
        const key = materialKey(bucket.mat)
        let g = groups.get(key)
        if (!g) groups.set(key, (g = { mat: bucket.mat, items: [], verts: 0 }))
        g.items.push({ bucket, input })
        g.verts += bucket.geo.getAttribute('position').count
      }
    }

    // 2. one exact-sized BatchedMesh per key (geometry is non-indexed → 0 index space);
    //    the FIRST material seen for a key is the shared/canonical material for its batch.
    const animEntities = new Set<BuiltEntity>()
    for (const [key, g] of groups) {
      const batch = new THREE.BatchedMesh(g.items.length, g.verts, 0, g.mat)
      batch.name = 'batch:' + key
      batch.frustumCulled = false // never cull the whole batch (its bounds span the scene)
      // per-instance culling defaults ON but needs reliable per-geometry bounds; until
      // that's wired it wrongly culls in-view instances, so keep it OFF during bring-up.
      batch.perObjectFrustumCulled = false
      this.batches.set(key, batch)
      this.group.add(batch)

      for (const { bucket, input } of g.items) {
        const geoId = batch.addGeometry(bucket.geo)
        const id = batch.addInstance(geoId)
        bucket.geo.dispose() // fully copied into the batch's pooled buffer by addGeometry
        const frame = bucket.frame ? (input.built.nodes.get(bucket.frame) ?? null) : null
        const inst: Instance = {
          batch,
          id,
          frame,
          placement: input.placement,
          built: input.built,
          entityId: input.id,
          node: bucket.frame,
          slotRanges: bucket.slotRanges,
        }
        this.setMatrix(inst)
        this.instances.push(inst)
        if (frame) {
          this.animated.push(inst)
          animEntities.add(input.built)
        }
      }
    }
    this.animatedEntities = [...animEntities]
  }

  // world matrix for one instance from the sim graph + placement (see file header).
  private setMatrix(inst: Instance): void {
    if (inst.frame) _m.multiplyMatrices(inst.placement, inst.frame.inner.matrixWorld)
    else _m.copy(inst.placement)
    inst.batch.setMatrixAt(inst.id, _m)
  }

  // Per frame: the AnimPlayers already mutated the entities' node `outer` transforms
  // (via EntityPreview.update). Refresh each animated instance's matrix + visibility from
  // the freshly-updated sim graph. Static instances never change, so they're skipped.
  update(): void {
    for (const built of this.animatedEntities) built.group.updateWorldMatrix(false, true)
    for (const inst of this.animated) {
      this.setMatrix(inst)
      inst.batch.setVisibleAt(inst.id, visibleInTree(inst.frame!.outer))
    }
  }

  // Toggle per-instance frustum culling on every batch (needs per-instance bounds, which
  // BatchedMesh derives from each added geometry). Off during bring-up so nothing vanishes.
  setPerInstanceCulling(on: boolean): void {
    for (const batch of this.batches.values()) batch.perObjectFrustumCulled = on
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      this.group.remove(batch)
      batch.dispose()
    }
    this.batches.clear()
    this.instances = []
    this.animated = []
    this.animatedEntities = []
  }
}
