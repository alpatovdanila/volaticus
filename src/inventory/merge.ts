// Per-entity static mesh merge — the draw-call optimization. Every entity is
// built from dozens of primitive meshes (a house ≈ 180 draws). This folds the
// STATIC subset into one mesh per distinct material, cutting draws ~10-25× on
// complex props, with NO visual change (same geometry, materials, UVs — only the
// batching differs).
//
// Two modes:
//   • keepSource:false (game / level) — the merged-away source meshes are removed
//     and disposed; only the merged meshes remain.
//   • keepSource:true (inventory studio) — the source meshes are KEPT (for slot
//     picking / outlines / shatter) but moved to a non-rendered layer; the merged
//     meshes render in their place. So the studio shows exactly what ships while
//     staying fully editable. On every rebuild the entity re-merges.
//
// Animated/toggled nodes merge WITHIN their own frame: their primitives fold to
// one mesh per material attached under the node's `inner` group, so clips and
// state show/hide keep driving the node's `outer` transform/visibility while a
// multi-primitive limb still costs one draw. What stays separate (never merged):
// currently-hidden meshes (a later state may show them individually). Entities that
// shatter (effect: SCRIPT_EFFECT_SHATTER) still merge — the shatter throws whatever
// pieces are visible; keepSource:true keeps the primitives when a finer break is wanted.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { BuiltEntity } from './factory'
import type { EntityMaterial } from './materials'
import type { EntityDoc } from './schema'

// meshes on this layer are pickable (explicit raycast) but NOT rendered by the
// camera or the shadow pass (both test the main camera's layer 0).
export const HIDDEN_LAYER = 1

// Nodes that form their own merge FRAME: any a clip animates (transform tracks)
// or a state/modifier toggles (show/hide). Their geometry — own primitives and
// static descendants — merges per material UNDER the node's inner group instead
// of the entity root, so the node's live transform/visibility is preserved.
function keepSeparateNodes(doc: EntityDoc): Set<string> {
  const set = new Set<string>()
  for (const clip of Object.values(doc.anims ?? {})) for (const tr of clip.tracks) set.add(tr.node)
  const addSH = (o?: { show?: string[]; hide?: string[] }): void => {
    for (const n of o?.show ?? []) set.add(n)
    for (const n of o?.hide ?? []) set.add(n)
  }
  for (const m of Object.values(doc.modifiers ?? {})) addSH(m)
  for (const [k, v] of Object.entries(doc.states ?? {}))
    if (k !== 'initial' && v && typeof v === 'object') addSH(v as { show?: string[]; hide?: string[] })
  return set
}

// Two materials share a draw call iff they render identically. Key by everything
// that reaches the pixel: bound textures (the SHARED cache objects — uvScale and
// uvRot are baked into geometry UVs by the factory, so slots differing only in
// texture direction/density carry identical uuids and fold into one draw), tint,
// PBR scalars, and the rasterization flags.
//
// Parallax materials bind their maps via NODE graphs and null the classic slots, so
// m.map/normalMap/… all read '_' here — without the parallaxKey line they'd hash
// identically and distinct materials would collapse into one wrong bucket. materials.ts
// publishes their node-texture identity on userData.parallaxKey for exactly this test.
export function materialKey(m: EntityMaterial): string {
  const u = (t: THREE.Texture | null): string => (t ? t.uuid : '_')
  return [
    u(m.map), u(m.normalMap), u(m.roughnessMap), u(m.metalnessMap),
    u(m.aoMap), u(m.emissiveMap), u(m.bumpMap), u(m.alphaMap),
    m.color.getHexString(), m.emissive.getHexString(),
    m.roughness, m.metalness, m.aoMapIntensity, m.bumpScale, m.emissiveIntensity, m.envMapIntensity,
    m.normalScale ? `${m.normalScale.x},${m.normalScale.y}` : '_',
    m.flatShading ? 1 : 0, m.side, m.transparent ? 1 : 0, m.opacity, m.alphaTest, m.vertexColors ? 1 : 0,
    (m.userData.parallaxKey as string | undefined) ?? '_',
  ].join('|')
}

function visibleInTree(o: THREE.Object3D): boolean {
  let c: THREE.Object3D | null = o
  while (c) {
    if (!c.visible) return false
    c = c.parent
  }
  return true
}

// slice a vertex range [start, start+count) of a NON-indexed geometry into a
// standalone geometry carrying position/normal/uv (all a merge needs).
function sliceGroup(src: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const sub = new THREE.BufferGeometry()
  const cut = (name: string, size: number): void => {
    const a = src.getAttribute(name) as THREE.BufferAttribute | undefined
    if (!a) return
    sub.setAttribute(name, new THREE.Float32BufferAttribute((a.array as Float32Array).slice(start * size, (start + count) * size), size))
  }
  cut('position', 3)
  cut('normal', 3)
  cut('uv', 2)
  if (!sub.getAttribute('normal')) sub.computeVertexNormals()
  if (!sub.getAttribute('uv')) sub.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((count) * 2), 2))
  return sub
}

interface Sub {
  geo: THREE.BufferGeometry
  slot: string
  tris: number
}

export interface MergeBucket {
  geo: THREE.BufferGeometry // concatenated same-material subs, baked into frame-local space
  mat: EntityMaterial
  frame: string // '' = static (group-local space); else the frame node name (that node's inner-local space)
  slotRanges: { tri0: number; tris: number; slot: string }[]
}

// Collapse an entity's primitives into ONE concatenated single-material geometry per
// (frame, material) bucket — the SHARED stage 1 for both consumers: mergeBuiltEntity
// below (buckets → THREE.Mesh, the studio/game per-entity merge) and the SceneBatcher
// (buckets → BatchedMesh instances). Pure geometry: it builds/concatenates geometry and
// reports which source meshes were folded, but does NOT touch the scene graph, the
// materials, or the render layers.
//
// Buckets are entity-LOCAL: static geometry is baked into the entity group's local
// space (frame ''), a frame node's geometry into that node's inner-local space — so a
// consumer places the whole entity via a group/frame WORLD MATRIX, not by moving geom.
// The single-material split (per geometry group) is exactly what BatchedMesh needs.
export function computeMergeBuckets(
  built: BuiltEntity,
  doc: EntityDoc,
): { buckets: MergeBucket[]; replaced: THREE.Mesh[] } {
  const keep = keepSeparateNodes(doc)
  built.group.updateWorldMatrix(false, true) // fresh world matrices for the whole subtree

  // frame = the nearest animated/toggled ancestor's `inner` group (so baked geometry
  // rides that node's live transform), or the entity group for static geometry.
  const frameOf = (mesh: THREE.Mesh): { name: string; parent: THREE.Object3D } => {
    let o: THREE.Object3D | null = mesh
    while (o && o !== built.group) {
      if (o.name && keep.has(o.name) && built.nodes.has(o.name)) return { name: o.name, parent: built.nodes.get(o.name)!.inner }
      o = o.parent
    }
    return { name: '', parent: built.group }
  }

  const raw = new Map<string, { mat: EntityMaterial; frame: string; subs: Sub[] }>()
  const replaced: THREE.Mesh[] = [] // source meshes folded into a bucket

  for (const mesh of built.meshes) {
    if (!visibleInTree(mesh)) continue // hidden — left individual for a later state/modifier show

    // NOTE meshes on an animated/toggled node are NOT skipped: frameOf resolves the
    // node itself as their frame, so its primitives fold to one bucket per material in
    // the node's inner-local space — motion/visibility ride the node's outer transform.
    const frame = frameOf(mesh)
    const localToFrame = new THREE.Matrix4().copy(frame.parent.matrixWorld).invert().multiply(mesh.matrixWorld)
    const geo = mesh.geometry
    const nonIdx = geo.index ? geo.toNonIndexed() : geo.clone()
    const vertCount = nonIdx.getAttribute('position').count
    const groups = nonIdx.groups.length ? nonIdx.groups : [{ start: 0, count: vertCount, materialIndex: 0 }]
    const slotByIndex = (mesh.userData.slotByIndex as string[]) ?? []
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]

    for (const g of groups) {
      const count = g.count === Infinity ? vertCount - g.start : g.count
      if (count <= 0) continue
      const mi = g.materialIndex ?? 0
      const mat = (mats[mi] ?? mats[0]) as EntityMaterial
      const sub = sliceGroup(nonIdx, g.start, count)
      sub.applyMatrix4(localToFrame) // bake node transform into the geometry (position + normal)
      const key = frame.name + ' ' + materialKey(mat)
      let b = raw.get(key)
      if (!b) raw.set(key, (b = { mat, frame: frame.name, subs: [] }))
      b.subs.push({ geo: sub, slot: slotByIndex[mi] ?? slotByIndex[0] ?? '', tris: count / 3 })
    }
    nonIdx.dispose()
    replaced.push(mesh)
  }

  const buckets: MergeBucket[] = []
  for (const b of raw.values()) {
    const geos = b.subs.map((s) => s.geo)
    const mergedGeo = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)
    if (!mergedGeo) {
      for (const g of geos) g.dispose()
      continue
    }
    if (geos.length > 1) for (const g of geos) g.dispose() // merge copied them
    const uv = mergedGeo.getAttribute('uv')
    if (uv && !mergedGeo.getAttribute('uv2')) mergedGeo.setAttribute('uv2', uv) // aoMap samples uv2
    // faceIndex → slot map, so the editor can still pick a material slot on a bucket
    let tri = 0
    const slotRanges = b.subs.map((s) => {
      const r = { tri0: tri, tris: s.tris, slot: s.slot }
      tri += s.tris
      return r
    })
    buckets.push({ geo: mergedGeo, mat: b.mat, frame: b.frame, slotRanges })
  }
  return { buckets, replaced }
}

export function mergeBuiltEntity(built: BuiltEntity, doc: EntityDoc, opts: { keepSource: boolean }): void {
  // SKELETAL entities are already assembled as SkinnedMeshes bound to a bone tree —
  // folding them into rigid merged meshes would freeze the bind pose. Skip entirely.
  if (doc.skinned) return
  const { buckets, replaced } = computeMergeBuckets(built, doc)
  if (!buckets.length) return // nothing static to merge (e.g. a fully-animated rig)

  const mergedMeshes: THREE.Mesh[] = []
  for (const b of buckets) {
    const parent = (b.frame ? built.nodes.get(b.frame)?.inner : null) ?? built.group
    const mesh = new THREE.Mesh(b.geo, b.mat)
    mesh.userData.merged = true
    mesh.userData.nodeName = parent.name || built.group.name
    mesh.userData.slotRanges = b.slotRanges
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    mergedMeshes.push(mesh)
  }

  if (opts.keepSource) {
    // studio: hide the source primitives from the camera (kept for picking/outlines/
    // shatter — those raycast/iterate built.meshes explicitly).
    for (const m of replaced) {
      m.layers.set(HIDDEN_LAYER)
    }
  } else {
    // game / level: drop the source primitives entirely.
    for (const m of replaced) {
      m.removeFromParent()
      m.geometry.dispose()
    }
    const gone = new Set(replaced)
    built.meshes = built.meshes.filter((m) => !gone.has(m)).concat(mergedMeshes)
  }
}
