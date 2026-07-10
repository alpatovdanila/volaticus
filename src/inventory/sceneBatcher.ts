// SceneBatcher — the cross-entity draw-call collapser. Given a set of built entities +
// their world placements, it runs the shared merge (computeMergeBuckets) on each DISTINCT
// built entity, then pools every (frame, material) bucket ACROSS ALL entities into one
// THREE.BatchedMesh per distinct batchMaterialKey. Draw calls for the whole scene =
// distinct-material count, independent of entity/placement count.
//
// Stage 1 (merge) freezes each entity's same-material geometry into one blob per
// (frame, material) in ENTITY-LOCAL space — ONCE per distinct BuiltEntity: repeated
// placements of the same built entity (a forest of one tree) share the pooled geometry
// and only add instances. Stage 2 (here) adds each blob to its material's batch as
// instances whose matrices carry the world placements:
//   • static bucket  → instance matrix = placement            (set once)
//   • frame  bucket  → instance matrix = placement · frameNode.inner.matrixWorld
//                      (re-pushed from the animation sim graph, but ONLY when it moved)
// Visibility toggles (state show/hide) map to BatchedMesh.setVisibleAt on the frame
// instance. Tint rides per instance (setColorAt), so slots differing only by color
// share one batch. Static and animated buckets go to SEPARATE batches (key suffix):
// a static batch's instance data is never re-uploaded by a moving neighbour.
import * as THREE from 'three'
import { computeMergeBuckets, batchMaterialKey, type MergeBucket } from './merge'
import type { BuiltEntity, BuiltNode } from './factory'
import type { EntityMaterial } from './materials'
import type { EntityDoc } from './schema'

// one entity to place into the batch. The built.group stays at the origin — the world
// placement lives ONLY in the per-instance matrices, so the merge's entity-local blobs
// compose cleanly with animation (which mutates the group's node transforms). The SAME
// BuiltEntity may appear in many inputs (one per placement) — its geometry pools once.
export interface BatchInput {
  built: BuiltEntity
  doc: EntityDoc
  id: string // entity id (for pick results)
  placement: THREE.Matrix4
}

// buildAsync progress: 'bucket' = merging entities into (frame, material) blobs,
// 'batch' = feeding blobs into the pooled BatchedMesh buffers.
export interface BatchProgress {
  phase: 'bucket' | 'batch'
  done: number
  total: number
}

export interface BatchBuildOptions {
  aborted?: () => boolean
  onProgress?: (p: BatchProgress) => void
  budgetMs?: number
  // extra addInstance capacity per batch, for runtime spawn() after the build
  // (despawned ids are recycled too). 0 = exact-size pools (the editor lineup).
  instanceHeadroom?: number
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
  last: Float32Array // moved-bit: last pushed matrix (16) — skip setMatrixAt when unchanged
  lastVis: boolean
}

// a spawned placement: the per-bucket instances of one BatchInput, despawnable as a unit
export interface SpawnHandle {
  instances: Instance[]
}

// one bucket's geometry registered into a batch — the dedup unit and the spawn template
interface RegisteredBucket {
  batch: THREE.BatchedMesh
  geoId: number
  frameName: string
  slotRanges: MergeBucket['slotRanges']
  color: THREE.Color // tint painted per instance (setColorAt)
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
  readonly batches = new Map<string, THREE.BatchedMesh>() // batch key → batch (one draw call each)
  private instances: Instance[] = []
  private animated: Instance[] = [] // subset needing per-frame matrix/visibility refresh
  private animatedEntities = new Set<BuiltEntity>() // entities owning ≥1 animated instance
  private registry = new Map<BuiltEntity, RegisteredBucket[]>() // built → its pooled buckets (dedup + spawn)

  constructor() {
    this.group.name = 'scene-batcher'
  }

  // Build all batches from the given entities. One-shot: call dispose() then build()
  // again to rebuild (the preview does this on every edit; the lineup once on enter).
  // Synchronous drain of buildSteps — the game/preview path, unchanged behaviour.
  build(inputs: BatchInput[], opts: Pick<BatchBuildOptions, 'instanceHeadroom'> = {}): void {
    const steps = this.buildSteps(inputs, opts.instanceHeadroom ?? 0)
    while (!steps.next().done) {
      /* drain */
    }
  }

  // ASYNC build: the same steps, drained on a per-frame time budget so the main thread
  // never freezes — bucketing/feeding a 44-entity lineup yields back to the frame loop
  // every ~budgetMs. `aborted()` is polled at every step (exit/reselect mid-build);
  // an abort cleans up everything fed so far (buildSteps' finally) and resolves false.
  // The caller keeps `group` hidden until this resolves true AND shaders/textures are
  // ready — that's the "render only when everything is ready" contract.
  async buildAsync(inputs: BatchInput[], opts: BatchBuildOptions = {}): Promise<boolean> {
    const budget = opts.budgetMs ?? 12
    const steps = this.buildSteps(inputs, opts.instanceHeadroom ?? 0)
    let sliceStart = performance.now()
    for (;;) {
      if (opts.aborted?.()) {
        steps.return(undefined) // runs buildSteps' finally → disposes partial work
        return false
      }
      const r = steps.next()
      if (r.done) return true
      opts.onProgress?.(r.value)
      if (performance.now() - sliceStart > budget) {
        // rAF yield, but hidden tabs suspend rAF (headless/preview) — race a
        // timeout so the build keeps flowing without a visible frame.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50)
          requestAnimationFrame(() => {
            clearTimeout(t)
            resolve()
          })
        })
        sliceStart = performance.now()
      }
    }
  }

  // The build machinery as resumable STEPS (one yield per DISTINCT entity bucketed, then
  // one per blob fed) — build() drains it synchronously, buildAsync() with yields.
  // The finally block makes early termination (generator .return on abort) safe: every
  // batch created and every un-fed bucket geometry is disposed, leaving the batcher empty.
  private *buildSteps(inputs: BatchInput[], instanceHeadroom: number): Generator<BatchProgress, void, void> {
    interface Plan {
      buckets: MergeBucket[]
      inputs: BatchInput[] // every placement of this built entity
    }
    interface Group {
      mat: EntityMaterial
      anim: boolean
      items: { bucket: MergeBucket; plan: Plan }[]
      verts: number
      indices: number
      instances: number
    }
    const plans = new Map<BuiltEntity, Plan>()
    const groups = new Map<string, Group>()
    let finished = false
    try {
      // 1. bucket every DISTINCT built entity (repeat placements reuse the plan);
      //    group buckets across entities by batch key; sum pool sizes once per bucket,
      //    instance counts once per placement.
      let bucketed = 0
      for (const input of inputs) {
        let plan = plans.get(input.built)
        if (!plan) {
          plan = { buckets: computeMergeBuckets(input.built, input.doc).buckets, inputs: [] }
          plans.set(input.built, plan)
          for (const bucket of plan.buckets) {
            const key = batchMaterialKey(bucket.mat) + (bucket.frame ? '|A' : '|S')
            let g = groups.get(key)
            if (!g) groups.set(key, (g = { mat: bucket.mat, anim: !!bucket.frame, items: [], verts: 0, indices: 0, instances: 0 }))
            g.items.push({ bucket, plan })
            g.verts += bucket.geo.getAttribute('position').count
            g.indices += bucket.geo.getIndex()?.count ?? 0
          }
          yield { phase: 'bucket', done: ++bucketed, total: inputs.length }
        }
        plan.inputs.push(input)
        for (const bucket of plan.buckets) groups.get(batchMaterialKey(bucket.mat) + (bucket.frame ? '|A' : '|S'))!.instances++
      }

      // 2. one exact-sized BatchedMesh per key (+ optional instance headroom for spawn).
      //    The batch material is a CLONE of the first bucket's with white color — tint
      //    is painted per instance, so color-only variants share the batch. The clone
      //    keeps the grafted TSL nodes + shared live uniforms (emissive/shadow/flat).
      const totalItems = [...groups.values()].reduce((n, g) => n + g.items.length, 0)
      let fed = 0
      for (const [key, g] of groups) {
        const mat = g.mat.clone() as EntityMaterial
        mat.color.set('#ffffff')
        mat.userData = g.mat.userData // share flags (catalogMat / parallaxKey) + patch marks
        const batch = new THREE.BatchedMesh(g.instances + instanceHeadroom, g.verts, g.indices, mat)
        batch.name = 'batch:' + key
        batch.frustumCulled = false // never cull the whole batch (its bounds span the scene)
        batch.perObjectFrustumCulled = true // per-instance culling (bounds come from each added geometry)
        batch.castShadow = true
        batch.receiveShadow = true
        this.batches.set(key, batch)
        this.group.add(batch)

        for (const { bucket, plan } of g.items) {
          const geoId = batch.addGeometry(bucket.geo)
          bucket.geo.dispose() // fully copied into the batch's pooled buffer by addGeometry
          const reg: RegisteredBucket = {
            batch,
            geoId,
            frameName: bucket.frame,
            slotRanges: bucket.slotRanges,
            color: bucket.mat.color.clone(),
          }
          // registry entry per built (the plan's first input carries the built/doc/id)
          const built = plan.inputs[0].built
          let regs = this.registry.get(built)
          if (!regs) this.registry.set(built, (regs = []))
          regs.push(reg)
          for (const input of plan.inputs) this.addInstanceFor(reg, input)
          yield { phase: 'batch', done: ++fed, total: totalItems }
        }
      }
      finished = true
    } finally {
      if (!finished) {
        // aborted mid-build: dispose every bucket geometry (double-dispose of already-fed
        // ones is harmless — they were never rendered) and every partial batch.
        for (const plan of plans.values()) for (const bucket of plan.buckets) bucket.geo.dispose()
        this.dispose()
      }
    }
  }

  // add one instance of a registered bucket for one placement (build feed + spawn).
  private addInstanceFor(reg: RegisteredBucket, input: BatchInput): Instance {
    const id = reg.batch.addInstance(reg.geoId)
    reg.batch.setColorAt(id, reg.color)
    const frame = reg.frameName ? (input.built.nodes.get(reg.frameName) ?? null) : null
    const inst: Instance = {
      batch: reg.batch,
      id,
      frame,
      placement: input.placement,
      built: input.built,
      entityId: input.id,
      node: reg.frameName,
      slotRanges: reg.slotRanges,
      last: new Float32Array(16),
      lastVis: true,
    }
    this.setMatrix(inst, true)
    this.instances.push(inst)
    if (frame) {
      this.animated.push(inst)
      this.animatedEntities.add(input.built)
    }
    return inst
  }

  // world matrix for one instance from the sim graph + placement (see file header).
  // Moved-bit: the matrix is only pushed to the batch when it actually changed since
  // the last push — idle animated instances cost a 16-float compare, no GPU upload.
  private setMatrix(inst: Instance, force = false): void {
    if (inst.frame) _m.multiplyMatrices(inst.placement, inst.frame.inner.matrixWorld)
    else _m.copy(inst.placement)
    const e = _m.elements
    const l = inst.last
    if (!force) {
      let same = true
      for (let i = 0; i < 16; i++)
        if (e[i] !== l[i]) {
          same = false
          break
        }
      if (same) return
    }
    inst.batch.setMatrixAt(inst.id, _m)
    l.set(e)
  }

  // Per frame: the AnimPlayers already mutated the entities' node `outer` transforms
  // (via EntityPreview.update). Refresh each animated instance's matrix + visibility from
  // the freshly-updated sim graph — writes reach the batch only on actual change.
  // Static instances never change, so they're skipped (and live in separate batches).
  update(): void {
    for (const built of this.animatedEntities) built.group.updateWorldMatrix(false, true)
    for (const inst of this.animated) {
      this.setMatrix(inst)
      const vis = visibleInTree(inst.frame!.outer)
      if (vis !== inst.lastVis) {
        inst.batch.setVisibleAt(inst.id, vis)
        inst.lastVis = vis
      }
    }
  }

  // RUNTIME SPAWN: add one more placement of an already-built entity (its geometry is
  // pooled — only instances are added). Requires the build to have run with
  // instanceHeadroom > 0 (or prior despawns freeing ids). Returns null when the entity
  // was never part of the build OR a batch is at instance capacity (partial adds are
  // rolled back, so a failed spawn leaves nothing behind).
  spawn(built: BuiltEntity, input: Omit<BatchInput, 'built'>): SpawnHandle | null {
    const regs = this.registry.get(built)
    if (!regs) return null
    const instances: Instance[] = []
    try {
      for (const reg of regs) instances.push(this.addInstanceFor(reg, { ...input, built }))
    } catch {
      this.despawn({ instances }) // capacity hit mid-way — roll back the partial placement
      return null
    }
    return { instances }
  }

  // RUNTIME DESPAWN: free a spawned placement's instances (ids recycle into the pool).
  despawn(handle: SpawnHandle): void {
    const drop = new Set(handle.instances)
    for (const inst of handle.instances) inst.batch.deleteInstance(inst.id)
    this.instances = this.instances.filter((i) => !drop.has(i))
    this.animated = this.animated.filter((i) => !drop.has(i))
  }

  // Toggle per-instance frustum culling on every batch (bounds come from each added
  // geometry). ON by default; exposed for A/B measurement.
  setPerInstanceCulling(on: boolean): void {
    for (const batch of this.batches.values()) batch.perObjectFrustumCulled = on
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      this.group.remove(batch)
      ;(batch.material as THREE.Material).dispose() // the batch's white-tint clone (per-batch material)
      batch.dispose()
    }
    this.batches.clear()
    this.instances = []
    this.animated = []
    this.animatedEntities.clear()
    this.registry.clear()
  }
}
