import * as THREE from 'three'
import { warmEffects } from '../inventory/effects'
import { applyEnvReflection } from '../inventory/envmap'
import { bakeEntityGeometry, bakeVariantLayouts, buildColliderViz, buildEntity, disposeEntity, ensureCraftSeeds, projectGeometryUv, rerollCraftSeeds, rerollPartSeed, type BakedGeometry, type BuiltEntity, type VariantLayout } from '../inventory/factory'
import { mergeBuiltEntity } from '../inventory/merge'
import { SceneBatcher, type BatchInput } from '../inventory/sceneBatcher'
import { scopeHmrReloads } from '../lib/hmr-scope'
import { stringifyPretty } from '../inventory/json'
import { applyLiveTuning, catalogColorPath, catalogDefaultTint, DEFAULT_HEIGHT, makeSlotMaterial, materialLoadState, setLiveParam, setMaterialCatalog, setSurfacePresets, setTexturePack, setTintLive, type EntityMaterial } from '../inventory/materials'
import { MaterialPreview, previewShapeGeometry, PREVIEW_SHAPES, type PreviewShape, type PreviewUvProject } from './matpreview'
import { preloadEntityMeshes } from '../inventory/meshes'
import { setParallaxConfig, getParallaxSamples } from '../inventory/parallax'
import { EntityPreview } from '../inventory/preview'
import { Inventory, SETTINGS_PATH, type ItemKind } from '../inventory/registry'
import { ensureAudio, playSfx, preloadSfx } from '../inventory/sfx'
import { contextDimsOf, resolveMaterials, walkRig, type EntityDoc, type MaterialCatalogDoc, type MaterialDef } from '../inventory/schema'
import {
  $,
  initMatPicker,
  renderItemList,
  renderMgrList,
  renderMgrTuning,
  renderOverlay,
  renderSlotChips,
  setPickInfo,
  setStats,
  setTitle,
  setValidation,
  toast,
  type MgrMaps,
  type MgrTuning,
  type OverridableKey,
  type SlotInfo,
} from './ui'
import { Viewport, type LightParams, HDRIS } from './viewport'
import './style.css'

const inv = new Inventory()
const vp = new Viewport($('#canvas-wrap'))
;(window as unknown as Record<string, unknown>).__dbg = {
  get vp() {
    return vp
  },
  get lineupBatcher() {
    return lineupBatcher
  },
  get mgrPreview() {
    return mgrPreview
  },
}

interface Selection {
  kind: ItemKind
  id: string
  built?: BuiltEntity
  preview?: EntityPreview
  pickedSlot: string | null
  variantIndex: number // which baked variant is shown (0..variants.count-1)
  baked?: BakedGeometry // cached baked geometry for this selection (fetched or freshly baked)
  dirty: boolean
  collider?: THREE.Object3D | null
  effectLoop?: number
}

// how many baked geometry variants an entity has (default 1).
function variantCount(doc: EntityDoc | undefined): number {
  return Math.max(1, doc?.variants?.count ?? 1)
}

// does any node actually get craft-jittered? (generated lumber always jitters;
// plain shapes only when craft is set.) Gates the "reroll craft" button — no point
// offering it on an entity with nothing crooked to reroll.
function hasCraftGeometry(doc: EntityDoc | undefined): boolean {
  if (!doc) return false
  let found = false
  walkRig(doc.rig, (_n, node) => {
    if (node.craft !== undefined || isGeneratedShape(node.shape)) found = true
  })
  return found
}

const geomPath = (id: string, i: number) => `entities/${id}/${id}.geom.${i}.json`
const variantsPath = (id: string) => `entities/${id}/${id}.variants.json`

// Persist a freshly-baked geometry set to its sidecar files (studio only). Compact
// JSON — these are machine data, not hand-edited.
async function saveBaked(id: string, baked: BakedGeometry): Promise<void> {
  for (let i = 0; i < baked.length; i++) await inv.save(geomPath(id, i), JSON.stringify(baked[i]))
}

async function saveVariants(id: string, layouts: VariantLayout[]): Promise<void> {
  await inv.save(variantsPath(id), JSON.stringify({ format: 1, variants: layouts }))
}

// Load the STORED variant layouts (<id>.variants.json). Missing, unparseable, or a
// stale length (count changed) → re-roll fresh + save. Craft edits reuse these, so
// the arrangement holds still; only "Regenerate variants" replaces them.
async function loadVariants(id: string, doc: EntityDoc): Promise<VariantLayout[]> {
  const count = variantCount(doc)
  let existing: VariantLayout[] | null = null
  const res = await fetch('/__inv/read?path=' + encodeURIComponent(variantsPath(id)))
  if (res.ok) {
    try {
      const layouts = JSON.parse((await res.json()).content)?.variants
      // valid = resolved-manifest shape (rejects stale pre-manifest files)
      if (Array.isArray(layouts) && layouts.every((l) => l?.parts)) existing = layouts as VariantLayout[]
    } catch {
      /* re-roll below */
    }
  }
  if (existing && existing.length === count) return existing
  // count changed (or no file): PRESERVE existing arrangements — a plain count edit
  // must not reshuffle the variants the user already has. Grow → keep all + append
  // only the new ones; shrink → keep the first `count`; no file → roll `count`.
  const layouts = !existing
    ? bakeVariantLayouts(doc)
    : existing.length > count
      ? existing.slice(0, count)
      : [...existing, ...bakeVariantLayouts(doc, count - existing.length)]
  await saveVariants(id, layouts)
  return layouts
}

// Mirror an ensure/reroll seed map into a rig (the raw JSON). Returns whether any
// craftSeed changed, so the caller only persists the entity file when needed.
function applySeedMap(rig: Record<string, unknown>, map: Record<string, number>): boolean {
  let changed = false
  walkRig(rig as never, (name, node) => {
    const n = node as { craftSeed?: number }
    if (map[name] !== undefined && n.craftSeed !== map[name]) {
      n.craftSeed = map[name]
      changed = true
    }
  })
  return changed
}

// Ensure the doc's per-part craft seeds exist (or apply a supplied reroll map),
// mirror them into the raw JSON, and persist the entity file if they changed. Seeds
// live IN the entity JSON, so a geom bake that assigns/rerolls them must save it.
async function persistSeeds(item: { path: string; raw: unknown; doc: EntityDoc }, seedMap?: Record<string, number>): Promise<void> {
  const map = seedMap ?? ensureCraftSeeds(item.doc)
  const changed = applySeedMap((item.raw as EntityDoc).rig as never, map)
  if (changed) await inv.save(item.path, stringifyPretty(item.raw))
}

// Load an entity's baked geometry: fetch every variant sidecar if they ALL exist,
// otherwise compose fresh (seeds + layouts) + save (the "no geometry yet" trigger).
async function loadBaked(id: string, doc: EntityDoc): Promise<BakedGeometry> {
  const count = variantCount(doc)
  const loaded: BakedGeometry = []
  for (let i = 0; i < count; i++) {
    const res = await fetch('/__inv/read?path=' + encodeURIComponent(geomPath(id, i)))
    if (!res.ok) break
    try {
      loaded.push(JSON.parse((await res.json()).content))
    } catch {
      break
    }
  }
  if (loaded.length === count) return loaded
  const item = inv.entities.get(id)
  if (item?.doc) await persistSeeds(item as never)
  const baked = bakeEntityGeometry(doc, await loadVariants(id, doc))
  await saveBaked(id, baked)
  return baked
}

// sel-cached: reuse the current selection's baked set across rebuilds, so material/
// UV edits are instant (no re-bake). Only fetches/bakes when not already cached.
async function ensureBaked(id: string, doc: EntityDoc): Promise<BakedGeometry> {
  if (sel?.id === id && sel.baked) return sel.baked
  return loadBaked(id, doc)
}

// Persist an entity's FULL state for `id` as ONE unit — entity JSON (seeds + any
// pending authored edits) + variants sidecar + geom sidecars. Every write targets
// `id` (not the live selection), so a mid-flight selection change can't leave a
// half-written, mismatched set (the source of the reroll/regenVariants desync bugs).
// `freshLayouts` (Regenerate variants) replaces the stored layouts; otherwise the
// PRESERVED layouts are reused so a craft edit never reshuffles the arrangement.
async function bakeAndSaveAll(id: string, freshLayouts?: VariantLayout[]): Promise<BakedGeometry | null> {
  const item = inv.entities.get(id)
  if (!item?.doc) return null
  await preloadEntityMeshes(item.doc)
  // seeds: ensure present, mirror into the raw JSON
  applySeedMap((item.raw as EntityDoc).rig as never, ensureCraftSeeds(item.doc))
  // source first: the whole entity JSON (seeds + any pending authored edits), once
  await inv.save(item.path, stringifyPretty(item.raw))
  // then the derived sidecars — variants (preserved or the fresh roll) + geom
  const layouts = freshLayouts ?? (await loadVariants(id, item.doc))
  if (freshLayouts) await saveVariants(id, freshLayouts)
  const baked = bakeEntityGeometry(item.doc, layouts)
  await saveBaked(id, baked)
  return baked
}

// Re-compose after a craft/sub edit or reroll: unify-write the whole entity, then
// reconcile the live view + clear dirty ONLY if this entity is still selected. A bake
// IS a save — entity JSON + sidecars land together, so nothing drifts on disk.
async function regen(freshLayouts?: VariantLayout[]): Promise<void> {
  if (!sel || sel.kind !== 'entity') return
  const id = sel.id
  const baked = await bakeAndSaveAll(id, freshLayouts)
  // id's files are consistent regardless; only touch the view if still selected
  if (!baked || sel?.id !== id) return
  sel.baked = baked
  sel.dirty = false
  setTitle(id, false)
  rebuild()
}

// Regenerate variants (explicit): re-roll the layouts (new oneOf/chance/rotJitter
// arrangement); regen persists them + the geom as one unit.
async function regenVariants(): Promise<void> {
  const id = sel?.id
  const doc = id ? inv.entities.get(id)?.doc : undefined
  if (!id || !doc) return
  await regen(bakeVariantLayouts(doc))
}

// Reroll craft (explicit): fresh crookedness for every part (layouts untouched).
async function rerollCraft(): Promise<void> {
  const id = sel?.id
  const doc = id ? inv.entities.get(id)?.doc : undefined
  if (!id || !doc) return
  rerollCraftSeeds(doc) // mutate doc seeds; regen's ensureCraftSeeds keeps + persists them
  await regen()
}

// Reroll one part (its whole seam-group, so welded frame corners can't crack) —
// the per-part ⟲ in the gen bar. `slot` is a material slot; reroll every node on it.
async function rerollPart(slot: string): Promise<void> {
  const id = sel?.id
  const doc = id ? inv.entities.get(id)?.doc : undefined
  if (!id || !doc) return
  const nodeNames = nodesUsingSlot(doc, slot).map((e) => e.name)
  if (!nodeNames.length) return
  rerollPartSeed(doc, nodeNames) // seam-group-aware; regen persists
  await regen()
}

let sel: Selection | null = null
let matPicker: { refresh(): void; reveal(id: string): void } | null = null
let listFilter = ''
let framedOnce = false // fit the camera only on the very first selection after boot

const effectDeps = {
  playSfx: (id: string) => {
    const item = inv.sfx.get(id)
    if (item?.doc) playSfx(item.doc)
  },
  addShake: (a: number) => vp.addShake(a),
}

function playEffectById(id: string, at: THREE.Vector3, params?: { texture?: string; tint?: string }): void {
  const item = inv.effects.get(id)
  if (item?.doc) vp.effects.play(item.doc, at, effectDeps, params)
}

function flashMeshes(hex: string): void {
  if (!sel?.built) return
  for (const m of sel.built.slotMaterials.values()) {
    m.emissive.set(hex)
    m.emissiveIntensity = 0.9
  }
  setTimeout(() => {
    if (!sel?.built) return
    for (const m of sel.built.slotMaterials.values()) {
      m.emissive.set(m.userData.baseEmissiveIntensity ? '#ffffff' : '#000000')
      m.emissiveIntensity = m.userData.baseEmissiveIntensity ?? 0
    }
  }, 130)
}

// ---------------------------------------------------------------------------
// selection / rebuild

function clearSelection(): void {
  if (sel?.built) disposeEntity(sel.built)
  if (sel?.collider) sel.collider.removeFromParent()
  if (sel?.effectLoop) clearInterval(sel.effectLoop)
  if (sel?.preview) vp.onUpdate.delete(previewTick)
  sel = null
  vp.setOutline([])
  setPickInfo('')
  setStats('')
}

// ---------------------------------------------------------------------------
// wireframe toggle + polycount (debug views over the CURRENT build — reapplied
// on every rebuild so they survive variant cycles / regen / slot edits)

let wireOn = false

function applyWire(): void {
  if (sel?.built) for (const m of sel.built.slotMaterials.values()) m.wireframe = wireOn
  if (lineup) for (const l of lineup) for (const m of l.built.slotMaterials.values()) m.wireframe = wireOn
  for (const m of mgrMats) m.wireframe = wireOn
  ;($('#btn-wire') as HTMLButtonElement).classList.toggle('active', wireOn)
}

function triCount(meshes: THREE.Mesh[]): number {
  let tris = 0
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry
    tris += (g.getIndex() ? g.getIndex()!.count : g.getAttribute('position').count) / 3
  }
  return Math.round(tris)
}

function updateStats(): void {
  if (sel?.built) setStats(`▲ ${triCount(sel.built.meshes).toLocaleString('en-US')} tris`)
  else if (lineup) setStats(`▲ ${triCount(lineup.flatMap((l) => l.built.meshes)).toLocaleString('en-US')} tris (lineup)`)
  else setStats('')
}

const previewTick = (dt: number) => sel?.preview?.update(dt)

function select(kind: ItemKind, id: string, opts: { keepCamera?: boolean; keepState?: boolean } = {}): void {
  const prevState = opts.keepState ? sel?.preview?.current : undefined
  const prevIndex = sel?.id === id ? sel.variantIndex : 0
  if (sel?.id !== id) collapsedGroups.clear() // item 34: collapse state is per-entity, in-memory
  exitLineup()
  clearSelection()
  sel = { kind, id, pickedSlot: null, variantIndex: prevIndex, dirty: false }
  localStorage.setItem('volaticus.sel', kind + ':' + id)

  const item = kind === 'entity' ? inv.entities.get(id) : kind === 'effect' ? inv.effects.get(id) : inv.sfx.get(id)
  setTitle(id + (item?.doc && 'name' in item.doc && item.doc.name ? ' — ' + (item.doc as { name: string }).name : ''), false)
  setValidation(item?.issues ?? [])

  if (kind === 'entity') {
    const doc = inv.entities.get(id)?.doc
    if (doc) void buildSelectedEntity(doc, prevState ?? undefined)
  }
  refreshOverlay()
  refreshSlots()
  renderItemList(inv, listFilter, kind + ':' + id, { onSelect: select })
}

// #32 (rapid flips): buildSelectedEntity awaits mesh preloads, so two quick
// rebuilds could overlap — both would then add their group to the scene and the
// earlier one leaked in place (stale geometry overlapping the fresh build).
// A monotonic token lets only the LATEST build land.
let buildToken = 0

// does any binding of this doc request the death shatter? A serialized scan for the
// reserved keyword is the cheap, shape-proof test (it can sit in states.*.enter,
// states.*.cues.*, events.*, or a byContext override).
function canShatter(doc: EntityDoc): boolean {
  return JSON.stringify(doc).includes('SCRIPT_EFFECT_SHATTER')
}

async function buildSelectedEntity(doc: EntityDoc, restoreState?: string): Promise<void> {
  if (!sel) return
  const mySel = sel
  const myToken = ++buildToken
  await preloadEntityMeshes(doc)
  if (sel !== mySel || myToken !== buildToken) return // superseded while meshes were loading
  let baked: BakedGeometry
  try {
    baked = await ensureBaked(sel.id, doc)
  } catch (e) {
    setValidation(['bake/load error: ' + String(e)])
    return
  }
  if (sel !== mySel || myToken !== buildToken) return // superseded while baking/loading
  sel.baked = baked
  const count = baked.length || 1
  sel.variantIndex = ((sel.variantIndex % count) + count) % count
  try {
    sel.built = buildEntity(doc, baked[sel.variantIndex])
    // WYSIWYG: render the SAME merged object the game/level ships. Keeps the
    // source primitives (hidden on a non-render layer) for slot picking + outlines
    // + shatter; re-runs on every rebuild so edits stay reflected.
    mergeBuiltEntity(sel.built, doc, { keepSource: true })
  } catch (e) {
    setValidation(['factory error: ' + String(e)])
    return
  }
  applyEnvReflection(sel.built.group) // surface presets keep their opt-in sheen
  vp.patchEmissive(sel.built.group) // global emissive self-illum lift
  vp.root.add(sel.built.group)
  if (sel.collider) {
    // keep the collider viz in sync with the freshly (re)built entity — here, where
    // sel.built exists (rebuild() kicks this off async, so it can't do it itself)
    sel.collider.removeFromParent()
    sel.collider = buildColliderViz(doc, sel.built.bounds)
    if (sel.collider) vp.scene.add(sel.collider)
  }
  const hideAndRespawn = () => {
    // preview convenience: hide, then respawn into the initial state
    if (!sel?.built || !sel.preview) return
    sel.built.group.visible = false
    const p = sel.preview
    setTimeout(() => {
      if (sel?.preview !== p || !sel.built) return
      sel.built.group.visible = true
      if (p.initial) p.setState(p.initial, 0)
      refreshOverlay()
    }, 1100)
  }
  sel.preview = new EntityPreview(doc, sel.built, {
    playSfx: effectDeps.playSfx,
    playEffect: playEffectById,
    flash: flashMeshes,
    shatter: () => {
      if (sel?.built) vp.effects.shatterMeshes(sel.built.meshes)
    },
    // hideGeometry (a reaction) + onDespawn (a state's despawnAfter) preview the same
    // in the studio — hide the entity, respawn after a beat; in the game they diverge.
    hideGeometry: hideAndRespawn,
    onDespawn: hideAndRespawn,
  })
  if (restoreState && sel.preview.stateNames.includes(restoreState)) sel.preview.setState(restoreState, 0)
  vp.onUpdate.add(previewTick)
  if (!framedOnce) {
    vp.fit(sel.built.bounds)
    framedOnce = true
  }
  refreshOverlay()
  refreshSlots()
  highlightSlot(sel.pickedSlot) // re-apply the outline on the freshly built meshes
  if (wireOn) applyWire() // debug views persist across rebuilds
  updateStats()
  // pre-clone this build's materials into the shatter pool and compile them in
  // the background — clicking "died" (shatter) must never link shaders. Skipped
  // pre-env (boot's warmEffects covers the booted selection once the HDRI
  // lands) and for entities whose states never shatter.
  if (vp.scene.environment && canShatter(doc) && sel.built)
    void warmEffects(vp.renderer, vp.scene, vp.camera, [], sel.built.meshes).catch(() => {})
}

function rebuild(opts: { keepState?: boolean } = { keepState: true }): void {
  if (!sel || sel.kind !== 'entity') return
  const doc = inv.entities.get(sel.id)?.doc
  if (!doc) return
  const state = opts.keepState ? sel.preview?.current : undefined
  if (sel.built) disposeEntity(sel.built)
  sel.built = undefined // don't double-dispose if another rebuild lands first
  vp.onUpdate.delete(previewTick)
  void buildSelectedEntity(doc, state ?? undefined) // collider viz refreshed inside, once sel.built exists
  refreshSlots()
}

// ---------------------------------------------------------------------------
// overlay + right panel

function refreshOverlay(): void {
  if (!sel) return renderOverlay(null, overlayCb)
  const doc = sel.kind === 'entity' ? inv.entities.get(sel.id)?.doc : undefined
  renderOverlay(
    {
      kind: sel.kind,
      states: sel.preview?.stateNames ?? [],
      current: sel.preview?.current ?? null,
      events: Object.keys(doc?.events ?? {}),
      modifiers: Object.keys(doc?.modifiers ?? {}),
      modifier: sel.preview?.modifier ?? null,
      contextDims: doc ? contextDimsOf(doc) : undefined,
      context: sel.preview?.context,
      variant: doc ? { index: sel.variantIndex, count: variantCount(doc) } : undefined,
      canReroll: hasCraftGeometry(doc),
    },
    overlayCb,
  )
}

const overlayCb = {
  onState: (name: string) => {
    ensureAudio()
    sel?.preview?.setState(name)
  },
  onEvent: (name: string) => {
    ensureAudio()
    sel?.preview?.fireEvent(name)
  },
  onTriggerEffect: () => {
    ensureAudio()
    if (sel?.kind === 'effect') playEffectById(sel.id, new THREE.Vector3(0, 0.8, 0))
  },
  onPlaySfx: () => {
    ensureAudio()
    if (sel?.kind === 'sfx') effectDeps.playSfx(sel.id)
  },
  onNextVariant: () => {
    // step through the STORED variant set — a pure replay, nothing regenerates
    if (!sel || sel.kind !== 'entity') return
    sel.variantIndex = (sel.variantIndex + 1) % variantCount(inv.entities.get(sel.id)?.doc)
    rebuild()
    refreshOverlay()
  },
  onRegenVariants: () => {
    // re-roll the variant LAYOUTS (new oneOf/chance/rotJitter arrangement) into
    // <id>.variants.json, then re-compose the geom sidecars.
    void regenVariants().then(() => {
      refreshOverlay()
      toast('re-rolled variants')
    })
  },
  onRerollCraft: () => {
    // fresh craft crookedness for every part (new stored seeds) — layouts stay put.
    void rerollCraft().then(() => toast('re-rolled craft'))
  },
  onCollider: (show: boolean) => {
    if (!sel) return
    if (sel.collider) {
      sel.collider.removeFromParent()
      sel.collider = null
    }
    if (show) {
      const doc = inv.entities.get(sel.id)?.doc
      if (doc && sel.built) {
        sel.collider = buildColliderViz(doc, sel.built.bounds)
        if (sel.collider) vp.scene.add(sel.collider)
      }
    }
  },
  onResetCam: () => {
    if (sel?.built) vp.fit(sel.built.bounds)
  },
  onContext: (dim: string, value: string | null) => {
    if (!sel?.preview) return
    if (value) sel.preview.context[dim] = value
    else delete sel.preview.context[dim]
  },
  onModifier: (name: string | null) => {
    // visibility overlay on top of the current state — combineable with any anim
    sel?.preview?.setModifier(name)
    refreshOverlay()
  },
}

// bindings that carry a parameterized effect ({ id, texture, tint }) — offered
// as extra "fx" chips in the slots panel so their texture is assignable too
function collectFxTextures(
  doc: EntityDoc,
): { key: string; label: string; texture?: string; tint?: string; inheritSlot?: string; uvRot: number }[] {
  const out: { key: string; label: string; texture?: string; tint?: string; inheritSlot?: string; uvRot: number }[] =
    []
  // item 34: fx chips show the slot's RESOLVED material/tint (inherit chains applied)
  const resolved = resolveMaterials(doc.materials)
  const add = (path: (string | number)[], label: string, binding: unknown) => {
    const eff = (binding as { effect?: unknown })?.effect
    if (eff && typeof eff === 'object') {
      const e = eff as { texture?: string; tint?: string; slot?: string; uvRot?: number }
      out.push({
        key: 'fx:' + JSON.stringify(path),
        label: 'fx · ' + label,
        texture: e.slot ? slotThumb(resolved[e.slot]?.material ?? '') : e.texture,
        tint: e.slot ? resolved[e.slot]?.tint : e.tint,
        inheritSlot: e.slot,
        uvRot: e.uvRot ?? 0,
      })
    }
  }
  for (const [ev, b] of Object.entries(doc.events ?? {})) add(['events', ev], ev, b)
  for (const [st, val] of Object.entries(doc.states ?? {})) {
    if (st === 'initial' || typeof val === 'string') continue
    const s = val as { enter?: unknown; cues?: Record<string, unknown> }
    add(['states', st, 'enter'], st + ' enter', s.enter)
    for (const [t, b] of Object.entries(s.cues ?? {})) add(['states', st, 'cues', t], `${st} @${t}`, b)
  }
  return out
}

function bindingAtPath(obj: unknown, path: (string | number)[]): { effect?: unknown } | undefined {
  let cur: unknown = obj
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur as { effect?: unknown } | undefined
}

function setSlotParam(
  slot: string,
  param: 'uvMode' | 'uvRot' | 'uvScale' | 'tint' | 'uvProject',
  value: string,
): void {
  if (!sel || sel.kind !== 'entity') return
  const item = inv.entities.get(sel.id)
  if (!item?.doc) return
  // item 34: on an INHERITING slot every change persists as an OVERRIDE key —
  // even at the "default" value (deleting the key would mean "revert to
  // parent"; that's the explicit ↺ reset's job). Standalone slots keep the
  // original delete-on-default behavior.
  const inheriting = item.doc.materials[slot]?.inherit !== undefined
  const apply = (mats: Record<string, Record<string, unknown>>) => {
    const m = mats[slot]
    if (!m) return
    if (param === 'uvMode') {
      if (value === 'tile' && !inheriting) delete m.uvMode
      else m.uvMode = value
    } else if (param === 'uvScale') {
      const v = parseFloat(value)
      if (v === 1 && !inheriting) delete m.uvScale
      else m.uvScale = v
    } else if (param === 'tint') {
      if (value.toLowerCase() === '#ffffff' && !inheriting) delete m.tint
      else m.tint = value
    } else if (param === 'uvProject') {
      // '' = none/authored. Standalone: default → drop the key. INHERITING:
      // persist the explicit schema value 'none' (item 34 round 2) — deleting
      // would re-bind to the parent's projection and snap the dropdown back;
      // 'none' pins "authored UVs" as an override like any other value.
      if (value === '') {
        if (inheriting) m.uvProject = 'none'
        else delete m.uvProject
      } else m.uvProject = value
    } else {
      const deg = parseInt(value, 10)
      if (deg === 0 && !inheriting) delete m.uvRot
      else m.uvRot = deg
    }
  }
  apply((item.raw as EntityDoc).materials as never)
  apply(item.doc.materials as never)
  sel.dirty = true
  setTitle(sel.id, true)
  inv.crossValidate()
  setValidation(item.issues)
  rebuild()
}

// item 34: ↺ — delete an override key so the slot re-binds to the live parent
// value (or, on a standalone slot, back to the default).
function resetSlotParam(slot: string, param: OverridableKey): void {
  if (!sel || sel.kind !== 'entity') return
  const item = inv.entities.get(sel.id)
  if (!item?.doc) return
  for (const target of [item.raw as EntityDoc, item.doc]) {
    const m = target.materials[slot] as Record<string, unknown> | undefined
    if (m) delete m[param]
  }
  sel.dirty = true
  setTitle(sel.id, true)
  inv.crossValidate()
  setValidation(item.issues)
  rebuild()
}

// item 34: remembers each slot's parent across an uncheck (freeze), so
// re-checking "inherit" re-binds to the FORMER parent, not the dropdown's
// first candidate. In-memory only (session-scoped) — the frozen JSON has no
// inherit key by design, so persistence would contradict the freeze.
const frozenParents = new Map<string, string>() // "<entityId>\0<slot>" → former parent
const frozenKey = (id: string, slot: string) => id + '\0' + slot

// item 34: the chip's "inherit from" row. parent = slot name → (re-)bind
// (existing own keys stay as overrides); parent = null → detach: freeze every
// currently-resolved value as an own key so the part looks identical standalone.
function setSlotInherit(slot: string, parent: string | null): void {
  if (!sel || sel.kind !== 'entity') return
  const item = inv.entities.get(sel.id)
  if (!item?.doc) return
  // resolve BEFORE mutating — the frozen values must be the pre-detach ones
  const resolved = resolveMaterials(item.doc.materials)[slot] ?? {}
  const former = item.doc.materials[slot]?.inherit
  if (!parent && former !== undefined) frozenParents.set(frozenKey(sel.id, slot), former)
  for (const target of [item.raw as EntityDoc, item.doc]) {
    const m = target.materials[slot] as Record<string, unknown> | undefined
    if (!m) continue
    if (parent) {
      m.inherit = parent
    } else {
      delete m.inherit
      for (const k of ['material', 'tint', 'uvMode', 'uvScale', 'uvRot', 'uvProject', 'flat'] as const) {
        const v = (resolved as Record<string, unknown>)[k]
        if (v !== undefined && m[k] === undefined) m[k] = v
      }
    }
  }
  sel.dirty = true
  setTitle(sel.id, true)
  inv.crossValidate()
  setValidation(item.issues)
  rebuild()
}

// Live per-slot tint while dragging the chip color picker: recolor the already-
// built materials for this slot directly (materialTint × slotTint), no rebuild.
// The final value is committed (JSON + rebuild) by setSlotParam on 'change'.
function setSlotTintLive(slot: string, value: string): void {
  if (!sel?.built || sel.kind !== 'entity') return
  const doc = inv.entities.get(sel.id)?.doc
  const matTint = doc ? catalogDefaultTint(resolveMaterials(doc.materials)[slot]?.material ?? '') : undefined
  const color = new THREE.Color('#ffffff')
  if (matTint) color.set(matTint)
  color.multiply(new THREE.Color(value))
  for (const m of sel.built.meshes) {
    const slots = (m.userData.slotByIndex as string[]) ?? []
    if (!slots.includes(slot)) continue
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (const mm of mats) if (mm.name === slot) (mm as THREE.MeshStandardMaterial).color.copy(color)
  }
}

function setFxInherit(key: string, slot: string | null): void {
  if (!sel || sel.kind !== 'entity' || !key.startsWith('fx:')) return
  const item = inv.entities.get(sel.id)
  if (!item?.doc) return
  const path = JSON.parse(key.slice(3)) as (string | number)[]
  // when unchecking, freeze the currently-resolved texture/tint as explicit values
  const resolved = (() => {
    const binding = bindingAtPath(item.doc, path)
    const eff = binding?.effect as { slot?: string; texture?: string; tint?: string } | string | undefined
    if (typeof eff !== 'object' || !eff) return {}
    if (eff.slot) {
      // item 34: freeze the slot's RESOLVED values (inherit chain applied)
      const m = resolveMaterials(item.doc!.materials)[eff.slot]
      // slots reference a catalog material now — freeze its color map as the texture
      return { texture: m?.material !== undefined ? slotThumb(m.material) : undefined, tint: m?.tint }
    }
    return { texture: eff.texture, tint: eff.tint }
  })()
  for (const target of [item.raw, item.doc]) {
    const binding = bindingAtPath(target, path)
    if (!binding) continue
    if (typeof binding.effect === 'string') binding.effect = { id: binding.effect }
    const eff = binding.effect as { id: string; slot?: string; texture?: string; tint?: string }
    if (slot) {
      eff.slot = slot
      delete eff.texture
      delete eff.tint
    } else {
      delete eff.slot
      if (resolved.texture) eff.texture = resolved.texture
      if (resolved.tint) eff.tint = resolved.tint
    }
  }
  sel.dirty = true
  setTitle(sel.id, true)
  inv.crossValidate()
  setValidation(item.issues)
  refreshSlots()
}

function setFxRot(key: string, deg: string): void {
  if (!sel || sel.kind !== 'entity' || !key.startsWith('fx:')) return
  const item = inv.entities.get(sel.id)
  if (!item?.doc) return
  const path = JSON.parse(key.slice(3)) as (string | number)[]
  const v = parseInt(deg, 10)
  for (const target of [item.raw, item.doc]) {
    const binding = bindingAtPath(target, path)
    if (!binding || typeof binding.effect !== 'object' || !binding.effect) continue
    const eff = binding.effect as { uvRot?: number }
    if (v === 0) delete eff.uvRot
    else eff.uvRot = v
  }
  sel.dirty = true
  setTitle(sel.id, true)
  refreshSlots()
}

// ---------------------------------------------------------------------------
// per-slot geometry generation (gen bar). The generator runs only here — on
// explicit request — and pins its decisions (craft/sub/seed) into the JSON.

function nodesUsingSlot(doc: EntityDoc, slot: string): { name: string; node: Record<string, unknown> }[] {
  const out: { name: string; node: Record<string, unknown> }[] = []
  walkRig(doc.rig, (name, n) => {
    if (!n.shape || n.shape === 'mesh' || !n.material) return
    const slots = typeof n.material === 'string' ? [n.material] : Object.values(n.material)
    if (slots.includes(slot)) out.push({ name, node: n as unknown as Record<string, unknown> })
  })
  return out
}

// same walk over the RAW json so saves carry the change
function rawNodesUsingSlot(raw: EntityDoc, slot: string): Record<string, unknown>[] {
  return nodesUsingSlot(raw, slot).map((e) => e.node)
}

// shapes whose geometry is always generated (craft defaults to 0.5 for them —
// craft 1 still generates, it just means machine-straight lumber)
function isGeneratedShape(shape: unknown): boolean {
  return shape === 'plank' || shape === 'post' || shape === 'ring' || shape === 'arrow' || shape === 'star'
}

function isGenerated(node: Record<string, unknown>): boolean {
  return node.craft !== undefined || isGeneratedShape(node.shape)
}

// per-part generation state shown inside each chip (null = no shaped nodes).
// UV projection left this row (#4/#5) — it is now a per-slot material override.
function slotGenInfo(
  doc: EntityDoc,
  slot: string,
): { craft: number | null; sub: number | null; has: boolean } | null {
  const nodes = nodesUsingSlot(doc, slot)
  if (!nodes.length) return null
  const gen = nodes.filter((e) => isGenerated(e.node))
  const crafts = gen.map((e) => (e.node.craft as number | undefined) ?? 0.5)
  const subs = nodes.map((e) => e.node.sub as number | undefined).filter((v) => v !== undefined) as number[]
  return {
    craft: crafts.length ? Math.round((crafts.reduce((a, b) => a + b, 0) / crafts.length) * 100) / 100 : null,
    sub: subs.length ? subs[0] : null,
    has: gen.length > 0,
  }
}

const genCb = {
  onGenCraft: (slot: string, value: number) => {
    if (!sel || sel.kind !== 'entity') return
    const item = inv.entities.get(sel.id)
    if (!item?.doc) return
    for (const target of [item.raw as EntityDoc, item.doc])
      for (const node of rawNodesUsingSlot(target, slot)) {
        // 1.0 turns the jitter OFF for plain shapes (delete craft); generated
        // lumber (plank/post/ring) defaults to 0.5 when craft is absent, so it
        // must keep the explicit value — deleting would snap the slider back
        if (value >= 0.995 && !isGeneratedShape(node.shape)) delete node.craft
        else node.craft = Math.round(value * 100) / 100
      }
    sel.dirty = true
    setTitle(sel.id, true)
    void regen() // craft changed → re-bake the geometry (one of the two regen triggers)
  },
  onGenSub: (slot: string, value: number | null) => {
    if (!sel || sel.kind !== 'entity') return
    const item = inv.entities.get(sel.id)
    if (!item?.doc) return
    for (const target of [item.raw as EntityDoc, item.doc])
      for (const node of rawNodesUsingSlot(target, slot)) {
        if (value === null) delete node.sub
        else node.sub = value
      }
    sel.dirty = true
    setTitle(sel.id, true)
    void regen() // subdivision changed → re-bake the geometry
  },
  onRegen: (slot: string) => {
    // per-part reroll: fresh craft seed for this part's node(s) — and their seam-
    // group, so a welded frame corner can't crack — then re-compose (layouts stay).
    void rerollPart(slot)
  },
}

// Slots now reference a catalog material — resolve its color map as the chip
// thumbnail. opacity/cutout/surface moved to the material (tuning); the chip
// shows the material name + its color map + per-slot tint/uv.
function slotThumb(materialId: string): string {
  return inv.materialCatalog()[materialId]?.maps.color ?? ''
}

// item 34: chip-list grouping state — which group parents are collapsed
// (in-memory only, cleared when another entity is selected)
const collapsedGroups = new Set<string>()

// ANY node referencing the slot (any shape, incl. meshes/face maps) — parents
// with none are pure group knobs (badge on the chip)
function slotHasGeometry(doc: EntityDoc, slot: string): boolean {
  let found = false
  walkRig(doc.rig, (_name, n) => {
    if (!n.material) return
    const slots = typeof n.material === 'string' ? [n.material] : Object.values(n.material)
    if (slots.includes(slot)) found = true
  })
  return found
}

// legal "inherit from" choices for a slot: any other slot whose own chain never
// passes through it (choosing one can't create a cycle)
function inheritCandidates(mats: Record<string, MaterialDef>, slot: string): string[] {
  return Object.keys(mats).filter((c) => {
    if (c === slot) return false
    const seen = new Set<string>()
    let cur: string | undefined = c
    while (cur !== undefined && mats[cur] && !seen.has(cur)) {
      if (cur === slot) return false
      seen.add(cur)
      cur = mats[cur].inherit
    }
    return true
  })
}

function refreshSlots(): void {
  const doc = sel?.kind === 'entity' ? inv.entities.get(sel.id)?.doc : undefined
  // item 34: chips display RESOLVED values (inherit chains applied), grouped as
  // a tree — parent chips first, their children indented beneath, collapsible.
  const resolved = doc ? resolveMaterials(doc.materials) : {}
  const slots: SlotInfo[] = []
  if (doc) {
    const mats = doc.materials
    const children = new Map<string, string[]>()
    const roots: string[] = []
    for (const [slot, def] of Object.entries(mats)) {
      const p = def.inherit
      if (p !== undefined && mats[p] && p !== slot) {
        if (!children.has(p)) children.set(p, [])
        children.get(p)!.push(slot)
      } else roots.push(slot) // standalone, or a dangling/self target (validation flags it)
    }
    // seen-guarded (item 34 round 2): cycle members ARE visited now, and an
    // a↔b children map would recurse forever without it.
    const countDesc = (slot: string, seen = new Set<string>()): number => {
      if (seen.has(slot)) return 0
      seen.add(slot)
      let n = 0
      for (const k of children.get(slot) ?? []) n += 1 + countDesc(k, seen)
      return n
    }
    const visit = (slot: string, depth: number, seen: Set<string>) => {
      if (seen.has(slot)) return // cycle guard (invalid docs stay renderable)
      seen.add(slot)
      const m = resolved[slot] ?? {}
      const def = mats[slot]
      const kids = children.get(slot) ?? []
      const collapsed = collapsedGroups.has(slot)
      // item 34 round 2: a slot INSIDE an inherit cycle (a↔b) has its CURRENT
      // parent filtered out by inheritCandidates (re-choosing it would "form"
      // the cycle that already exists) — without it the inherit row wouldn't
      // render and the cycle couldn't be repaired from the UI. Keep the actual
      // current parent listed so the row shows the true state; unchecking
      // (freeze) or picking another parent breaks the cycle.
      const inheritOpts = inheritCandidates(mats, slot)
      if (def.inherit !== undefined && mats[def.inherit] && def.inherit !== slot && !inheritOpts.includes(def.inherit))
        inheritOpts.unshift(def.inherit)
      slots.push({
        slot,
        texture: slotThumb(m.material ?? ''), // catalog color map for the thumbnail
        material: m.material ?? '',
        tint: m.tint ?? null,
        uvMode: m.uvMode ?? ('tile' as const),
        uvScale: m.uvScale ?? 1,
        uvRot: m.uvRot ?? 0,
        // 'none' (explicit authored-UVs override) displays as the '—' choice;
        // own.uvProject still marks it overridden → the ↺ reset shows.
        uvProject: (m.uvProject === 'none' ? '' : (m.uvProject ?? '')) as '' | 'box' | 'planar' | 'sphere',
        gen: slotGenInfo(doc, slot),
        inherit: def.inherit ?? null,
        // re-check "inherit" pre-selects the slot's former parent (pre-freeze)
        lastInherit: sel ? (frozenParents.get(frozenKey(sel.id, slot)) ?? null) : null,
        own: {
          material: def.material !== undefined,
          tint: def.tint !== undefined,
          uvMode: def.uvMode !== undefined,
          uvScale: def.uvScale !== undefined,
          uvRot: def.uvRot !== undefined,
          uvProject: def.uvProject !== undefined,
        },
        inheritOptions: inheritOpts,
        depth,
        groupParent: kids.length > 0,
        groupKnob: !slotHasGeometry(doc, slot),
        collapsed,
        childCount: countDesc(slot),
      })
      if (!collapsed) {
        for (const k of kids) visit(k, depth + 1, seen)
      } else {
        // collapsed: mark the whole hidden subtree as seen so the cycle-recovery
        // fallback below doesn't resurface these children as fake depth-0 roots
        // (they ARE reachable via this parent — just intentionally hidden).
        const markHidden = (s: string) => {
          if (seen.has(s)) return
          seen.add(s)
          for (const k of children.get(s) ?? []) markHidden(k)
        }
        for (const k of kids) markHidden(k)
      }
    }
    const seen = new Set<string>()
    for (const r of roots) visit(r, 0, seen)
    // item 34 round 2: an inherit cycle in which EVERY member has a valid
    // inherit key (a↔b) contains no root, so nothing above ever reaches it —
    // the chips would silently vanish. Surface each unreached cluster from its
    // first member (the seen-guard stops the loop); validation flags the doc,
    // but the user must be able to SEE and repair the cycle in the UI.
    for (const slot of Object.keys(mats)) if (!seen.has(slot)) visit(slot, 0, seen)
  }
  const fx = doc ? collectFxTextures(doc) : []
  renderSlotChips(
    slots,
    fx,
    sel?.pickedSlot ?? null,
    {
      onPick: (key) => {
        if (!sel) return
        sel.pickedSlot = key
        highlightSlot(key)
        setPickInfo(
          key.startsWith('fx:') ? 'effect texture — click a texture to assign' : `part: ${key} — click a texture to assign`,
        )
        refreshSlots()
        matPicker?.refresh()
      },
      onParam: setSlotParam,
      onTintLive: setSlotTintLive,
      onFxInherit: setFxInherit,
      onFxRot: setFxRot,
      onEditMaterial: editSlotMaterial,
      onInherit: setSlotInherit,
      onResetParam: resetSlotParam,
      onToggleCollapse: (slot) => {
        if (collapsedGroups.has(slot)) collapsedGroups.delete(slot)
        else collapsedGroups.add(slot)
        refreshSlots()
      },
      onShowInPicker: showSlotInPicker,
      ...genCb,
    },
    doc ? Object.keys(doc.materials) : undefined, // fx dropdowns list ALL slots, even collapsed-away
  )
}

// #38: chip menu → reveal the slot's RESOLVED material in the picker column
function showSlotInPicker(slot: string): void {
  if (!sel || sel.kind !== 'entity') return
  const doc = inv.entities.get(sel.id)?.doc
  const materialId = doc ? resolveMaterials(doc.materials)[slot]?.material : undefined
  if (!materialId || !inv.materialCatalog()[materialId]) {
    toast('no catalog material on this part')
    return
  }
  matPicker?.reveal(materialId)
}

// #14: from a part chip's right-click menu — open the Material Manager overlay
// (currently the manager MODE; the next phase converts it to an overlay, this
// call site stays the same) focused on the material that slot uses.
function editSlotMaterial(slot: string): void {
  if (!sel || sel.kind !== 'entity') return
  const doc = inv.entities.get(sel.id)?.doc
  const materialId = doc ? resolveMaterials(doc.materials)[slot]?.material : undefined
  if (!materialId || !inv.materialCatalog()[materialId]) {
    toast('no editable material on this part')
    return
  }
  openMaterialEditor(materialId)
}

// #37: shared entry — the manager overlay focused on a specific material
// (chip menu + picker-tile right-click)
function openMaterialEditor(materialId: string): void {
  if (!inv.materialCatalog()[materialId]) return
  if (!mgrMode) enterMgr()
  selectMaterial(materialId)
}

function highlightSlot(slot: string | null): void {
  if (!sel?.built || !slot || slot.startsWith('fx:')) return vp.setOutline([])
  vp.setOutline(sel.built.meshes.filter((m) => ((m.userData.slotByIndex as string[]) ?? []).includes(slot)))
}

// ---------------------------------------------------------------------------
// picking + texture assignment

let downAt: [number, number] | null = null
vp.renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]))
vp.renderer.domElement.addEventListener('pointerup', (e) => {
  ensureAudio()
  if (!downAt) return
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
  downAt = null
  if (moved > 5 || !sel?.built) return
  const hit = vp.pick(e.clientX, e.clientY, sel.built.meshes)
  if (!hit) {
    sel.pickedSlot = null
    vp.setOutline([])
    setPickInfo('')
    refreshSlots()
    return
  }
  sel.pickedSlot = hit.slot
  highlightSlot(hit.slot)
  setPickInfo(`node: ${hit.nodeName}${hit.face !== 'all' ? ' · face: ' + hit.face : ''} · part: ${hit.slot}`)
  // item 39 (+34): expand any collapsed ancestor group so the chip exists, then
  // scroll it into view — with 30+ exploded chips it must never be off-screen.
  const doc = inv.entities.get(sel.id)?.doc
  if (doc) {
    const seen = new Set<string>()
    let cur = doc.materials[hit.slot]?.inherit
    while (cur !== undefined && doc.materials[cur] && !seen.has(cur)) {
      seen.add(cur)
      collapsedGroups.delete(cur)
      cur = doc.materials[cur].inherit
    }
  }
  refreshSlots()
  document
    .querySelector(`#slot-chips .slot-chip[data-slot="${CSS.escape(hit.slot)}"]`)
    ?.scrollIntoView({ block: 'nearest' })
  matPicker?.refresh()
})

// Assign a catalog material id to the picked target. A normal slot gets
// `slot.material = id`; an fx effect texture gets the material's color map (fx
// debris still carries a raw texture path, not a material ref).
function assignMaterial(materialId: string): void {
  if (!sel || sel.kind !== 'entity') return
  if (!sel.pickedSlot) {
    toast('pick a primitive (or part chip) first')
    return
  }
  const item = inv.entities.get(sel.id)
  if (!item?.doc) return
  if (sel.pickedSlot.startsWith('fx:')) {
    const tex = catalogColorPath(materialId)
    const path = JSON.parse(sel.pickedSlot.slice(3)) as (string | number)[]
    for (const target of [item.raw, item.doc]) {
      const binding = bindingAtPath(target, path)
      if (!binding) continue
      if (typeof binding.effect === 'string') binding.effect = { id: binding.effect }
      ;(binding.effect as { texture?: string }).texture = tex
    }
  } else {
    const slot = sel.pickedSlot
    const apply = (mats: Record<string, Record<string, unknown>>) => {
      if (mats[slot]) mats[slot].material = materialId
    }
    apply((item.raw as EntityDoc).materials as never)
    apply(item.doc.materials as never)
  }
  sel.dirty = true
  setTitle(sel.id, true)
  inv.crossValidate()
  setValidation(item.issues)
  rebuild()
  highlightSlot(sel.pickedSlot)
  refreshSlots()
  matPicker?.refresh()
}

// ---------------------------------------------------------------------------
// save

async function save(): Promise<void> {
  if (!sel?.dirty) return
  const item = inv.entities.get(sel.id)
  if (!item) return
  try {
    await inv.save(item.path, stringifyPretty(item.raw))
    sel.dirty = false
    setTitle(sel.id, false)
    toast('saved ' + item.path)
  } catch (e) {
    toast('save failed: ' + String(e))
  }
}

;($('#btn-save') as HTMLButtonElement).onclick = () => void save()
;($('#mgr-save') as HTMLButtonElement).onclick = () => void mgrSave()
;($('#btn-lineup') as HTMLButtonElement).onclick = () => {
  if (mgrMode) exitMgr()
  void enterLineup()
}
;($('#btn-materials') as HTMLButtonElement).onclick = () => toggleMgr()
;($('#btn-wire') as HTMLButtonElement).onclick = () => {
  wireOn = !wireOn
  applyWire()
}

// ---------------------------------------------------------------------------
// #31: light-control popover (💡). Sliders live-apply to the entity viewport
// environment (HDRI / rotation / intensity / emissive — colors stay neutral
// white, WYSIWYG) and persist via Viewport.setLights (localStorage).

// The lighting is now SHARED: one LightParams (owned by the Viewport) drives both
// the entity viewport AND the material-manager preview. There are TWO identical
// popovers (topbar + inside the material modal); a change from either applies to
// both viewports and mirrors into both popovers.
const lightSyncers: ((p: LightParams) => void)[] = []
function pushLightsToAll(p: LightParams): void {
  mgrPreview?.applyLights(p) // no-op until the preview exists
  for (const s of lightSyncers) s(p)
}
function applyLightsEverywhere(partial: Partial<LightParams>): LightParams {
  const p = vp.setLights(partial) // entity viewport + persist
  pushLightsToAll(p)
  return p
}

// Wire one Light popover (id-prefixed) onto the shared LightParams. Called once per
// popover (topbar 'lt-', modal 'mgr-lt-').
function initLightPanel(cfg: { btn: string; pop: string; wrap: string; fp: string; reset: string }): void {
  const pop = $(cfg.pop)
  const btn = $(cfg.btn) as HTMLButtonElement
  const hdriSel = $(cfg.fp + 'hdri') as HTMLSelectElement
  const toneSel = $(cfg.fp + 'tonemap') as HTMLSelectElement
  const hideBgChk = $(cfg.fp + 'hidebg') as HTMLInputElement
  for (const h of HDRIS) {
    const o = document.createElement('option')
    o.value = h.id
    o.textContent = h.name
    hdriSel.appendChild(o)
  }
  const fields: {
    key: 'rotation' | 'intensity' | 'emissive'
    input: HTMLInputElement
    val: HTMLElement
    fmt(n: number): string
  }[] = (['rotation', 'intensity', 'emissive'] as const).map((key) => ({
    key,
    input: $(cfg.fp + key) as HTMLInputElement,
    val: $(cfg.fp + key + '-val'),
    fmt: (n: number) => (key === 'rotation' ? n.toFixed(0) + '°' : n.toFixed(2)),
  }))
  const sync = (p: LightParams) => {
    hdriSel.value = p.hdri
    toneSel.value = p.tonemap
    hideBgChk.checked = p.hideBg
    for (const f of fields) {
      f.input.value = String(p[f.key])
      f.val.textContent = f.fmt(p[f.key])
    }
  }
  lightSyncers.push(sync)
  hdriSel.onchange = () => applyLightsEverywhere({ hdri: hdriSel.value })
  toneSel.onchange = () => applyLightsEverywhere({ tonemap: toneSel.value as LightParams['tonemap'] })
  hideBgChk.onchange = () => applyLightsEverywhere({ hideBg: hideBgChk.checked })
  for (const f of fields) f.input.oninput = () => applyLightsEverywhere({ [f.key]: parseFloat(f.input.value) })
  ;($(cfg.reset) as HTMLButtonElement).onclick = () => pushLightsToAll(vp.resetLights())
  btn.onclick = () => {
    const open = pop.hasAttribute('hidden')
    if (open) {
      sync(vp.getLights())
      pop.removeAttribute('hidden')
    } else pop.setAttribute('hidden', '')
    btn.classList.toggle('active', open)
  }
  // close on outside click (but not while dragging inside the popover)
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element | null
    if (t?.closest?.(cfg.wrap)) return
    pop.setAttribute('hidden', '')
    btn.classList.remove('active')
  })
  sync(vp.getLights())
}
initLightPanel({ btn: '#btn-lights', pop: '#light-pop', wrap: '#light-wrap', fp: '#lt-', reset: '#lt-reset' })
initLightPanel({ btn: '#mgr-btn-lights', pop: '#mgr-light-pop', wrap: '#mgr-light-wrap', fp: '#mgr-lt-', reset: '#mgr-lt-reset' })

// Render-options popover — global render settings (parallax on/off + quality). Live via the
// shared parallax uniforms; persisted to localStorage.
// Rebuild whatever the studio is currently showing (Manager preview, else the selected entity). Only the
// parallax ON/OFF toggle needs this now — it's the one build-time material choice (off = plain PBR, no
// march). Every other material input is a live uniform and updates in place with no rebuild.
function rebuildShown(): void {
  if (mgrMode) rebuildMgrPreview()
  else if (sel?.kind === 'entity') rebuild()
}

const RENDER_KEY = 'volaticus.render'
function initRenderPanel(): void {
  const btn = $('#btn-render') as HTMLButtonElement
  const pop = $('#render-pop')
  const parallaxChk = $('#rn-parallax') as HTMLInputElement
  const samplesInput = $('#rn-samples') as HTMLInputElement
  const samplesVal = $('#rn-samples-val')
  const samplesRow = $('#rn-samples-row')
  let parallaxOn = false
  let samples = getParallaxSamples()
  try {
    const raw = localStorage.getItem(RENDER_KEY)
    if (raw) {
      const s = JSON.parse(raw) as { parallax?: boolean; samples?: number }
      parallaxOn = !!s.parallax
      if (typeof s.samples === 'number') samples = s.samples
    }
  } catch {
    /* non-fatal */
  }
  const persist = (): void => {
    try {
      localStorage.setItem(RENDER_KEY, JSON.stringify({ parallax: parallaxOn, samples }))
    } catch {
      /* private mode / quota */
    }
  }
  // apply() pushes the build-time config into the material builder + syncs the UI. It does NOT rebuild
  // (it also runs once at init, before anything is built); the handlers below rebuild on user change.
  const apply = (): void => {
    setParallaxConfig({ enabled: parallaxOn, samples })
    parallaxChk.checked = parallaxOn
    samplesInput.value = String(samples)
    samplesVal.textContent = String(samples)
    samplesRow.hidden = !parallaxOn
  }
  apply()
  parallaxChk.onchange = () => {
    parallaxOn = parallaxChk.checked
    apply()
    persist()
    rebuildShown() // the one build-time toggle: 'off' rebuilds to plain PBR (no march compiled in)
  }
  // quality is a LIVE global uniform now — drag writes samplesU directly, no rebuild.
  samplesInput.oninput = () => {
    samples = parseInt(samplesInput.value, 10)
    setParallaxConfig({ samples })
    samplesVal.textContent = String(samples)
  }
  samplesInput.onchange = persist // commit just persists the final value
  btn.onclick = () => {
    const willOpen = pop.hasAttribute('hidden')
    pop.toggleAttribute('hidden', !willOpen)
  }
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hasAttribute('hidden') && !$('#render-wrap').contains(e.target as Node)) pop.setAttribute('hidden', '')
  })
}
initRenderPanel()

// #7 modal controls: close (✕) + create/clone/delete (#16). Backdrop click closes.
;($('#mgr-close') as HTMLButtonElement).onclick = () => exitMgr()
;($('#mat-modal-backdrop') as HTMLElement).onclick = () => exitMgr()
;($('#mgr-new') as HTMLButtonElement).onclick = () => void mgrNew()
;($('#mgr-clone') as HTMLButtonElement).onclick = () => void mgrClone()
;($('#mgr-delete') as HTMLButtonElement).onclick = () => void mgrDelete()
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    void (mgrMode ? mgrSave() : save())
  }
  // #7: Esc closes the material overlay
  if (e.key === 'Escape' && mgrMode) {
    e.preventDefault()
    exitMgr()
  }
})

// ---------------------------------------------------------------------------
// lineup: every entity in one scene at real scale (rows by category)

let lineup: { built: BuiltEntity; preview: EntityPreview }[] | null = null
let lineupBatcher: SceneBatcher | null = null
const lineupTick = (dt: number) => {
  if (lineup) for (const l of lineup) l.preview.update(dt) // advance each entity's anim sim
  lineupBatcher?.update() // push animated frame instances to their BatchedMesh
}

function exitLineup(): void {
  if (!lineup) return
  if (lineupBatcher) {
    vp.root.remove(lineupBatcher.group)
    lineupBatcher.dispose()
    lineupBatcher = null
  }
  for (const l of lineup) disposeEntity(l.built)
  lineup = null
  vp.onUpdate.delete(lineupTick)
}

async function enterLineup(): Promise<void> {
  clearSelection()
  exitLineup()
  await Promise.all([...inv.entities.values()].filter((i) => i.doc).map((i) => preloadEntityMeshes(i.doc!)))
  localStorage.removeItem('volaticus.sel')
  setTitle('lineup — every entity at real scale', false)
  setValidation([])
  renderOverlay(null, overlayCb)
  refreshSlots()
  renderItemList(inv, listFilter, null, { onSelect: select })

  lineup = []
  const order = ['prop', 'pickup', 'enemy', 'character', 'levelpart']
  const items = [...inv.entities.values()]
    .filter((i) => i.doc)
    .sort(
      (a, b) =>
        order.indexOf(a.doc!.category) - order.indexOf(b.doc!.category) || a.id.localeCompare(b.id),
    )
  const GAP = 0.7
  const MAX_ROW_WIDTH = 15
  let x = 0
  let z = 0
  let rowDepth = 0
  // Each entity is built at the ORIGIN (group stays at identity); its grid placement is
  // folded into a per-instance matrix (below) so the merge's entity-local blobs batch
  // cleanly. The built graphs stay detached from the scene — they're the animation sim
  // only; the SceneBatcher renders their geometry.
  const inputs: BatchInput[] = []
  const lineupBox = new THREE.Box3()
  for (const item of items) {
    let built: BuiltEntity
    try {
      built = buildEntity(item.doc!, bakeEntityGeometry(item.doc!)[0])
    } catch {
      continue
    }
    applyEnvReflection(built.group) // patch the slot materials (the batch reuses them)
    vp.patchEmissive(built.group)
    const size = built.bounds.getSize(new THREE.Vector3())
    const center = built.bounds.getCenter(new THREE.Vector3())
    if (x > 0 && x + size.x > MAX_ROW_WIDTH) {
      x = 0
      z += rowDepth + 2
      rowDepth = 0
    }
    const px = x + size.x / 2 - center.x
    const pz = z - center.z
    x += size.x + GAP
    rowDepth = Math.max(rowDepth, size.z)
    const placement = new THREE.Matrix4().makeTranslation(px, 0, pz)
    lineupBox.union(built.bounds.clone().applyMatrix4(placement))
    // silent previews: everything animates, but 30 ambient sfx at once would be chaos
    const preview = new EntityPreview(item.doc!, built, {
      playSfx: () => {},
      playEffect: () => {},
      flash: () => {},
      shatter: () => {},
      hideGeometry: () => {},
      onDespawn: () => {},
    })
    lineup.push({ built, preview })
    inputs.push({ built, doc: item.doc!, id: item.id, placement })
  }
  lineupBatcher = new SceneBatcher()
  lineupBatcher.build(inputs)
  vp.root.add(lineupBatcher.group)
  vp.onUpdate.add(lineupTick)
  vp.fit(lineupBox)
  if (wireOn) applyWire()
  updateStats()
}

// ---------------------------------------------------------------------------
// catalog re-apply. Called on boot and on a settings/catalog change. Re-textures
// the current entity (or the manager preview).

function applyPack(): void {
  setTexturePack(inv.settings.texturePack, (p) => inv.hasTexture(p))
  setSurfacePresets(inv.settings.surfaces)
  setMaterialCatalog(inv.materialCatalog())
  if (mgrMode) rebuildMgrPreview()
  else rebuild()
  refreshSlots()
  matPicker?.refresh()
}

// ---------------------------------------------------------------------------
// MATERIAL MANAGER — an OVERLAY / modal (#7). The entity editor stays mounted
// underneath (never torn down); the modal dims a backdrop over it. Left = catalog
// list grouped by category (search); center = a DEDICATED preview canvas
// (MaterialPreview: own scene with skybox #11 + fixed light + auto-rotation #10,
// isolated from the entity viewport); right = tuning panel that writes
// inventory/materials/<id>.json (dirty + Ctrl+S). Also create/clone/delete (#16).

let mgrMode = false
let mgrSelId: string | null = null
let mgrDirty = false
let mgrPreview: MaterialPreview | null = null
let mgrMats: EntityMaterial[] = []
let mgrSearch = ''

// Per-material texture-load watch: while the selected material's maps are still
// decoding, show a spinner on its list row + an overlay on the preview instead of a
// black mesh. Polls texture.image (materialLoadState); clears when every map is in.
// texCache is shared, so re-selecting an already-loaded material clears instantly.
const mgrLoadingIds = new Set<string>()
let mgrLoadTimer = 0
function watchMgrLoad(id: string): void {
  window.clearInterval(mgrLoadTimer)
  const tick = () => {
    const st = materialLoadState(id)
    const loading = st.total > 0 && st.loaded < st.total
    const changed = mgrLoadingIds.has(id) !== loading
    if (loading) mgrLoadingIds.add(id)
    else mgrLoadingIds.delete(id)
    document.getElementById('mgr-loading')?.toggleAttribute('hidden', !(loading && id === mgrSelId))
    if (changed) refreshMgrList() // add / remove the row spinner
    if (!loading) window.clearInterval(mgrLoadTimer)
  }
  tick()
  if (mgrLoadingIds.has(id)) mgrLoadTimer = window.setInterval(tick, 120)
}

// Build (or rebuild) the SINGLE preview mesh (#17) via the runtime makeSlotMaterial
// so the manager shows EXACTLY what an entity slot would render — same material AND
// (now) the same shared HDRI lighting, patched with the same global-emissive lift.
// Tiling density + UV projection are PREVIEW-ONLY view controls (mgrPreview.uvScale
// / uvProject) — never read from the material tuning.
function rebuildMgrPreview(): void {
  if (!mgrPreview || !mgrSelId) return
  const spin = mgrPreview.spin
  for (const m of mgrMats) m.dispose()
  mgrMats = []
  while (spin.children.length) {
    const c = spin.children[0] as THREE.Mesh
    spin.remove(c)
    c.geometry.dispose()
  }
  const uvScale = mgrPreview.uvScale
  const proj = mgrPreview.uvProject || undefined // '' = keep the shape's authored UVs

  // Build the throwaway preview geometry, applying the preview-only projection AND
  // tiling by BAKING them into THIS geometry's UVs — exactly like the factory meters
  // entity UVs. Critically we do NOT touch texture.repeat: the cache textures are
  // SHARED with the entity scene, so a .repeat there would leak the viewing tiling
  // onto every real prop. uv2 (AO) mirrors uv.
  const geo = previewShapeGeometry(mgrPreview.shape)
  const projGeo = proj ? projectGeometryUv(geo, new THREE.Matrix4(), proj) : geo
  const uv = projGeo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (uv) {
    if (uvScale !== 1) {
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale)
      uv.needsUpdate = true
    }
    projGeo.setAttribute('uv2', uv) // AO reads uv2 = the (scaled/projected) uv
  }

  const mat = makeSlotMaterial('preview', { material: mgrSelId })
  const mesh = new THREE.Mesh(projGeo, mat)
  // same global-emissive lift every entity slot gets, so the preview reads
  // identically under the shared rig.
  mgrPreview.patch(mesh)
  spin.add(mesh)

  mgrMats = [mat]
  if (wireOn) for (const m of mgrMats) m.wireframe = true

  // watch this material's textures — spinner on the row + preview overlay until the
  // maps decode (otherwise the mesh shows black for the first frames).
  watchMgrLoad(mgrSelId)
}

function mgrTuningOf(id: string): MgrTuning | null {
  const doc = inv.materialCatalog()[id]
  if (!doc) return null
  const t = doc.tuning
  return {
    tint: t.tint,
    roughness: t.roughness,
    metalness: t.metalness,
    normalScale: t.normalScale,
    height: t.height ?? DEFAULT_HEIGHT,
    aoIntensity: t.aoIntensity,
    emissive: t.emissive,
    opacity: t.opacity,
    cutout: t.cutout,
    doubleSided: t.doubleSided,
    flat: t.flat,
    alphaMap: t.alphaMap ?? null, // #27
  }
}

// Which texture maps a material actually ships.
// Drives the tuning panel's show-if-present rules + the roughness/metalness badges.
function mgrMapsOf(id: string | null): MgrMaps {
  const doc = id ? inv.materialCatalog()[id] : undefined
  const has = (k: 'roughness' | 'metallic' | 'normal' | 'ao' | 'emissive' | 'height'): boolean =>
    !!(doc && doc.maps[k])
  return {
    roughness: has('roughness'),
    metallic: has('metallic'),
    normal: has('normal'),
    ao: has('ao'),
    emissive: has('emissive'),
    height: has('height'),
  }
}

function refreshMgrList(): void {
  const cat = inv.materialCatalog()
  const entries = Object.values(cat).map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    color: d.maps.color ?? '',
  }))
  renderMgrList(entries, mgrSearch, mgrSelId, selectMaterial, (id) => mgrLoadingIds.has(id))
}

function refreshMgrTuning(): void {
  if (!mgrSelId) return renderMgrTuning('Material', '', null, mgrMapsOf(null), mgrTuneCb)
  const doc = inv.materialCatalog()[mgrSelId]
  renderMgrTuning(mgrSelId + (mgrDirty ? ' •' : ''), doc?.category ?? '', mgrTuningOf(mgrSelId), mgrMapsOf(mgrSelId), mgrTuneCb)
}

// The material overlay owns its OWN dirty state (separate from the entity's), with
// its own Save button + "unsaved/saved" indicator in the modal head. Reflect
// mgrDirty onto them; the Save button is disabled when there's nothing to save.
function refreshMgrSaveState(): void {
  const dot = $('#mgr-dirty') as HTMLElement
  const btn = $('#mgr-save') as HTMLButtonElement
  const has = !!mgrSelId
  btn.disabled = !mgrDirty || !has
  dot.classList.toggle('dirty', mgrDirty)
  dot.classList.toggle('clean', has && !mgrDirty)
  dot.innerHTML = mgrDirty ? '●&nbsp;unsaved' : has ? '✓&nbsp;saved' : ''
}

// Write a tuning change into both the raw file and the validated doc, mark
// dirty, rebuild the preview live. Save is on Ctrl+S (mgrSave).
function setMgrTuning(mut: (t: Record<string, unknown>) => void): void {
  if (!mgrSelId) return
  const item = inv.materials.get(mgrSelId)
  if (!item?.doc) return
  for (const target of [item.raw as { tuning?: Record<string, unknown> }, item.doc as unknown as { tuning: Record<string, unknown> }]) {
    if (target.tuning) mut(target.tuning)
  }
  mgrDirty = true
  refreshMgrSaveState()
  // reflect the doc change into the runtime catalog + preview immediately — LIVE, no rebuild. Continuous
  // params update uniforms; flat/cutout/double-sided flip in place via applyLiveTuning's needsUpdate.
  setMaterialCatalog(inv.materialCatalog())
  const doc = inv.materialCatalog()[mgrSelId]
  if (doc) for (const m of mgrMats) applyLiveTuning(m, doc.tuning)
  refreshMgrTuning()
}

const mgrTuneCb = {
  onNum: (key: string, value: number) => setMgrTuning((t) => (t[key] = value)),
  // live-drag: write the parameter's uniform directly on the preview material — instant, no rebuild.
  onNumLive: (key: string, value: number) => {
    for (const m of mgrMats) setLiveParam(m, key, value)
  },
  onBool: (key: string, value: boolean) => setMgrTuning((t) => (t[key] = value)),
  onTint: (value: string | null) => setMgrTuning((t) => (t.tint = value)),
  // live default-tint on drag: recolor the preview material's tint uniform directly (no rebuild).
  onTintLive: (value: string) => {
    for (const m of mgrMats) setTintLive(m, value)
  },
  // #27: assign / clear the alpha mask path. Binding/unbinding a texture is STRUCTURAL, so this one
  // rebuilds the preview (it's a rare click, not a slider drag).
  onAlphaMap: (value: string | null) => {
    setMgrTuning((t) => {
      if (value === null) delete t.alphaMap
      else t.alphaMap = value
    })
    rebuildMgrPreview()
  },
  textures: () => inv.textures,
}

async function mgrSave(): Promise<void> {
  if (!mgrDirty || !mgrSelId) return
  const item = inv.materials.get(mgrSelId)
  if (!item) return
  try {
    await inv.save(item.path, stringifyPretty(item.raw))
    mgrDirty = false
    refreshMgrSaveState()
    toast('saved ' + item.path)
    refreshMgrTuning()
  } catch (e) {
    toast('save failed: ' + String(e))
  }
}

function selectMaterial(id: string): void {
  if (!inv.materialCatalog()[id]) return
  mgrSelId = id
  mgrDirty = false
  refreshMgrSaveState()
  rebuildMgrPreview()
  mgrPreview?.fit()
  refreshMgrList()
  refreshMgrTuning()
}

// #16: entities whose slots still reference a material id (referrers for the
// delete warning). Returns "<entity>.<slot>" strings.
function materialReferrers(id: string): string[] {
  const out: string[] = []
  for (const item of inv.entities.values()) {
    const mats = item.doc?.materials
    if (!mats) continue
    for (const [slot, m] of Object.entries(mats)) if (m.material === id) out.push(item.id + '.' + slot)
  }
  return out
}

// Leftover gap #1: "New" now DUPLICATES a real material (the selected one, or the
// first catalog material if nothing is selected) instead of writing an all-null-maps
// scaffold — that scaffold was useless (rendered magenta) AND a schema hazard, and
// left null-map catalog files on disk. A duplicate copies real color maps + tuning,
// so the new material is immediately usable. (Same clone path as item 16.)
async function mgrNew(): Promise<void> {
  const srcId = mgrSelId && inv.materials.has(mgrSelId) ? mgrSelId : [...inv.materials.keys()].sort()[0]
  if (!srcId) return void toast('no material to duplicate — the catalog is empty')
  const src = inv.materials.get(srcId)
  if (!src?.raw) return
  const name = prompt(`New material id (duplicates "${srcId}"):`, 'new_material')
  if (!name) return
  const id = name.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return void toast('bad id — use letters, digits, _ or -')
  if (inv.materials.has(id)) return void toast('a material "' + id + '" already exists')
  const clone = JSON.parse(JSON.stringify(src.raw)) as MaterialCatalogDoc
  clone.id = id // keep the source's real maps + tuning; only the id changes
  await createMaterialFile(id, clone)
}

// #16: DUPLICATE the selected material into a new inventory/materials/<newid>.json
// (copies maps + tuning verbatim, fresh id), immediately selected/editable.
async function mgrClone(): Promise<void> {
  if (!mgrSelId) return void toast('select a material to duplicate')
  const src = inv.materials.get(mgrSelId)
  if (!src?.raw) return
  const suggested = mgrSelId.replace(/_copy(\d*)$/, '') + '_copy'
  const name = prompt('Duplicate as (new id):', suggested)
  if (!name) return
  const id = name.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return void toast('bad id — use letters, digits, _ or -')
  if (inv.materials.has(id)) return void toast('a material "' + id + '" already exists')
  const clone = JSON.parse(JSON.stringify(src.raw)) as MaterialCatalogDoc
  clone.id = id // keep maps + tuning; only the id changes (maps stay the source's)
  await createMaterialFile(id, clone)
}

async function createMaterialFile(id: string, doc: MaterialCatalogDoc): Promise<void> {
  const path = 'materials/' + id + '.json'
  try {
    await inv.save(path, stringifyPretty(doc))
    // fetch it back through the normal path so the registry validates + registers it
    inv.applyFile(path, Date.now(), stringifyPretty(doc))
    inv.crossValidate()
    setMaterialCatalog(inv.materialCatalog())
    matPicker?.refresh()
    refreshMgrList()
    selectMaterial(id)
    toast('created ' + path)
  } catch (e) {
    toast('create failed: ' + String(e))
  }
}

// #16: DELETE the selected material file (trash). Warns + lists referrers if any
// entity slot still uses it; the user can proceed (models render magenta for
// that slot until re-pointed).
async function mgrDelete(): Promise<void> {
  if (!mgrSelId) return
  const id = mgrSelId
  const item = inv.materials.get(id)
  if (!item) return
  const refs = materialReferrers(id)
  const warn = refs.length
    ? `Delete material "${id}"?\n\n${refs.length} entity slot(s) still reference it:\n  ${refs.slice(0, 12).join('\n  ')}${refs.length > 12 ? `\n  …(+${refs.length - 12} more)` : ''}\n\nThey will render magenta until re-pointed. Proceed?`
    : `Delete material "${id}"? This removes ${item.path}.`
  if (!confirm(warn)) return
  try {
    await inv.delete(item.path)
    setMaterialCatalog(inv.materialCatalog())
    matPicker?.refresh()
    mgrSelId = null
    mgrDirty = false
    refreshMgrSaveState()
    const next = [...inv.materials.keys()].sort()[0]
    if (next) selectMaterial(next)
    else {
      refreshMgrList()
      refreshMgrTuning()
    }
    toast('deleted ' + item.path)
  } catch (e) {
    toast('delete failed: ' + String(e))
  }
}

function enterMgr(): void {
  if (mgrMode) return
  mgrMode = true
  ;($('#btn-materials') as HTMLButtonElement).classList.add('active')
  $('#mat-modal').removeAttribute('hidden')
  // OPTIMISTIC OPEN: paint the modal shell + loaders NOW, then do the heavy setup
  // (first-open preview rig, the 1300-row list, the first material) after a paint —
  // so the window appears instantly instead of freezing while it all builds.
  document.getElementById('mgr-loading')?.removeAttribute('hidden')
  const mgrList0 = document.getElementById('mgr-list')
  if (mgrList0 && !mgrList0.children.length) mgrList0.innerHTML = '<div class="hint">loading materials…</div>'
  // run the heavy setup after a paint (rAF), with a timeout fallback for tabs where
  // rAF is throttled/stalled (e.g. a hidden preview) so it always runs exactly once.
  let mgrSetupDone = false
  const runSetup = () => {
    if (mgrSetupDone || !mgrMode) return
    mgrSetupDone = true
    mgrEnterSetup()
  }
  requestAnimationFrame(() => requestAnimationFrame(runSetup))
  setTimeout(runSetup, 80)
}

// The heavy Material-Manager setup, deferred by enterMgr so the modal paints first.
function mgrEnterSetup(): void {
  // PERSISTENT preview: created once (its own HDRI LightingRig), reused thereafter —
  // paused while closed, resumed on open. Its wiring is set up once here.
  if (!mgrPreview) {
    mgrPreview = new MaterialPreview($('#mgr-canvas'))

    // #17: preview shape selector (ball default) — rebuilds the single shown mesh
    const shapeSel = $('#mgr-shape') as HTMLSelectElement
    shapeSel.innerHTML = ''
    for (const s of PREVIEW_SHAPES) {
      const o = document.createElement('option')
      o.value = s
      o.textContent = s
      shapeSel.appendChild(o)
    }
    shapeSel.value = mgrPreview.shape
    shapeSel.onchange = () => {
      if (!mgrPreview) return
      mgrPreview.setShape(shapeSel.value as PreviewShape) // persisted
      rebuildMgrPreview()
      mgrPreview.fit()
    }

    // auto-rotate (persisted; survives material switch / reopen). Lighting is now
    // the shared global rig — no per-preview fixed-light / env-intensity controls.
    const rot = $('#mgr-autorotate') as HTMLInputElement
    rot.checked = mgrPreview.autoRotate
    rot.onchange = () => {
      if (mgrPreview) mgrPreview.setAutoRotate(rot.checked)
    }

    // PREVIEW-ONLY tiling density — a viewing aid (never written to the material).
    // Rebuilds the shown mesh (tiling is baked into the preview geometry's UVs).
    const uvScaleSl = $('#mgr-uvscale') as HTMLInputElement
    const uvScaleVal = $('#mgr-uvscale-val') as HTMLElement
    uvScaleSl.value = String(mgrPreview.uvScale)
    uvScaleVal.textContent = String(mgrPreview.uvScale)
    uvScaleSl.oninput = () => {
      if (!mgrPreview) return
      const v = parseFloat(uvScaleSl.value)
      mgrPreview.setUvScale(v)
      uvScaleVal.textContent = String(v)
      rebuildMgrPreview()
    }

    // PREVIEW-ONLY UV projection — a viewing aid (never written to the material).
    const uvProjSel = $('#mgr-uvproject') as HTMLSelectElement
    uvProjSel.innerHTML = ''
    for (const [val, lbl] of [['', '—'], ['box', 'box'], ['planar', 'planar'], ['sphere', 'sphere']]) {
      const o = document.createElement('option')
      o.value = val
      o.textContent = lbl
      uvProjSel.appendChild(o)
    }
    uvProjSel.value = mgrPreview.uvProject
    uvProjSel.onchange = () => {
      if (!mgrPreview) return
      mgrPreview.setUvProject(uvProjSel.value as PreviewUvProject)
      rebuildMgrPreview()
      mgrPreview.fit()
    }
  }
  // resume the (persistent) preview and sync it to the CURRENT shared lighting so it
  // matches the main viewport the moment it opens.
  mgrPreview.resume()
  mgrPreview.applyLights(vp.getLights())
  const first = mgrSelId && inv.materialCatalog()[mgrSelId] ? mgrSelId : [...inv.materials.keys()].sort()[0]
  mgrSearch = ''
  ;($('#mgr-search') as HTMLInputElement).value = ''
  if (first) selectMaterial(first)
  else {
    refreshMgrList()
    refreshMgrTuning()
    refreshMgrSaveState()
  }
}

function exitMgr(): void {
  if (!mgrMode) return
  mgrMode = false
  mgrDirty = false
  ;($('#btn-materials') as HTMLButtonElement).classList.remove('active')
  $('#mat-modal').setAttribute('hidden', '')
  window.clearInterval(mgrLoadTimer)
  mgrLoadingIds.clear()
  // PERSISTENT preview: pause its render loop but KEEP it alive (its HDRI rig stays
  // warm, so reopening is instant — no EXR reload). Materials/mesh persist; the next
  // selectMaterial rebuilds them.
  mgrPreview?.pause()
  // the entity editor stayed mounted underneath. Rebuild it so any LIVE catalog
  // tuning made in the overlay (roughness/normalScale/tint/etc.) reflects on the
  // entity, then reflect the current selection's dirty title again.
  rebuild()
  if (sel) setTitle(sel.id, sel.dirty)
}

function toggleMgr(): void {
  if (mgrMode) exitMgr()
  else enterMgr()
}

// ---------------------------------------------------------------------------
// boot

async function boot(): Promise<void> {
  await inv.load()
  setTexturePack(inv.settings.texturePack, (p) => inv.hasTexture(p))
  setSurfacePresets(inv.settings.surfaces)
  setMaterialCatalog(inv.materialCatalog())

  const search = $('#search') as HTMLInputElement
  search.oninput = () => {
    listFilter = search.value.trim().toLowerCase()
    renderItemList(inv, listFilter, sel ? sel.kind + ':' + sel.id : null, { onSelect: select })
  }

  matPicker = initMatPicker({
    get materials() {
      const cat = inv.materialCatalog()
      return Object.values(cat)
        .map((d) => ({ id: d.id, category: d.category, color: d.maps.color ?? '' }))
        .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))
    },
    category: '',
    // the picked slot's currently-assigned material id (highlights the tile)
    get current() {
      if (!sel?.pickedSlot) return null
      const doc = inv.entities.get(sel.id)?.doc
      if (!doc) return null
      if (sel.pickedSlot.startsWith('fx:')) return null // fx debris keeps a raw texture, no id to match
      // item 34: resolved — an inheriting slot highlights its parent's material
      return resolveMaterials(doc.materials)[sel.pickedSlot]?.material ?? null
    },
    onAssign: assignMaterial,
    onEdit: openMaterialEditor, // #37: right-click a picker tile → Edit material
  })

  const mgrSearchEl = $('#mgr-search') as HTMLInputElement
  mgrSearchEl.oninput = () => {
    mgrSearch = mgrSearchEl.value.trim().toLowerCase()
    if (mgrMode) refreshMgrList()
  }

  inv.onChanged.add((paths) => {
    if (paths.includes(SETTINGS_PATH)) applyPack()
    // a catalog material file changed (manager tuning edit / hand-edit) —
    // refresh the runtime catalog and rebuild so slots re-texture in place
    else if (paths.some((p) => p.startsWith('materials/'))) {
      setMaterialCatalog(inv.materialCatalog())
      matPicker?.refresh()
      if (mgrMode) {
        // don't stomp an in-progress tuning edit; otherwise reflect the change
        if (mgrSelId && paths.some((p) => p.replace(/\.json$/, '').endsWith('/' + mgrSelId) || p === 'materials/' + mgrSelId + '.json')) {
          if (!mgrDirty) {
            rebuildMgrPreview()
            refreshMgrTuning()
          } else toast('material changed on disk (you have unsaved tuning!)')
        }
        refreshMgrList()
      } else if (sel?.kind === 'entity' && !sel.dirty) rebuild()
    }
    // external edit (usually Claude editing JSON by prompt) — rebuild in place
    renderItemList(inv, listFilter, sel ? sel.kind + ':' + sel.id : null, { onSelect: select })
    if (!sel) return
    const mine = paths.some((p) => p.split('/').pop()!.replace(/\.json$/, '') === sel!.id)
    const refsChanged = paths.some((p) => p.startsWith('effects/') || p.startsWith('sfx/'))
    if (mine && sel.kind === 'entity') {
      if (sel.dirty) toast('file changed on disk (you have unsaved changes!)')
      else {
        select(sel.kind, sel.id, { keepCamera: true, keepState: true })
        toast('reloaded ' + sel.id)
      }
    } else if (mine || refsChanged) {
      setValidation(
        (sel.kind === 'entity' ? inv.entities : sel.kind === 'effect' ? inv.effects : inv.sfx).get(sel.id)?.issues ?? [],
      )
    }
  })
  inv.startPolling()

  const remembered = localStorage.getItem('volaticus.sel')
  const [rk, rid] = remembered?.split(':') ?? []
  if (rk && rid && (rk === 'entity' ? inv.entities : rk === 'effect' ? inv.effects : inv.sfx).has(rid)) {
    select(rk as ItemKind, rid)
  } else {
    const first = [...inv.entities.keys()].sort()[0]
    if (first) select('entity', first)
    else renderItemList(inv, '', null, { onSelect: select })
  }

  // warm every effect + flash program once the HDRI env lands (env presence is
  // part of the shader program key — compiling earlier builds throwaway
  // variants). Fire-and-forget: firing a state / effect preview must never
  // link a shader mid-click (a 2-3s synchronous freeze on D3D11/ANGLE). Also
  // pre-clones the booted selection's materials into the shatter pool; later
  // selections warm per-build (see buildSelectedEntity).
  void (async () => {
    await new Promise<void>((resolve) => {
      if (vp.scene.environment) return resolve()
      const prior = vp.rig.onHdriLoaded
      const guard = window.setTimeout(resolve, 10000)
      vp.rig.onHdriLoaded = (tex) => {
        prior?.(tex)
        window.clearTimeout(guard)
        resolve()
      }
    })
    const docs = [...inv.effects.values()].flatMap((i) => (i.doc ? [i.doc] : []))
    await warmEffects(vp.renderer, vp.scene, vp.camera, docs, sel?.built?.meshes ?? [])
  })().catch(() => {})
  // decode every sample-backed sfx in the background (first ▶ plays instantly)
  preloadSfx([...inv.sfx.values()].flatMap((i) => (i.doc ? [i.doc] : [])))
}

// ---------------------------------------------------------------------------
// dev/scripting hooks (used by Claude to verify visually)

declare global {
  interface Window {
    __shot(name: string): Promise<string>
    __ed: {
      select(kind: ItemKind, id: string): void
      state(name: string): void
      event(name: string): void
      modifier(name: string | null): void
      trigger(): void
      reroll(): void
      context(dim: string, value: string | null): void
      lineup(): void
      materialManager(on?: boolean): boolean // toggle/set the Material Manager; returns the resulting state
      selectMaterial(id: string): void // select a catalog material in the manager
      bounds(): { min: number[]; max: number[]; size: number[] } | null
      cam(azimuthDeg: number, elevationDeg: number, dist?: number): void
      wire(on: boolean): void
      // #31: viewport lights — lights() reads, lights(partial) sets (persisted),
      // lights('reset') restores the defaults. Always returns the current params.
      lights(params?: Partial<LightParams> | 'reset'): LightParams
      ids(): Record<string, string[]>
      meshes(): { node: string; visible: boolean; worldScale: number[]; mats: string[] }[]
    }
  }
}

window.__shot = async (name: string) => {
  // in the material overlay, shoot the dedicated preview canvas
  const dataUrl = mgrMode && mgrPreview ? mgrPreview.screenshot() : vp.screenshot()
  const res = await fetch('/__shot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dataUrl }),
  })
  const json = await res.json()
  return json.file ?? JSON.stringify(json)
}

window.__ed = {
  select: (kind, id) => select(kind, id),
  state: (name) => {
    sel?.preview?.setState(name)
    refreshOverlay()
  },
  event: (name) => sel?.preview?.fireEvent(name),
  modifier: (name) => overlayCb.onModifier(name),
  trigger: () => overlayCb.onTriggerEffect(),
  reroll: () => overlayCb.onNextVariant(), // cycles the STORED variant set
  context: (dim, value) => {
    overlayCb.onContext(dim, value)
    refreshOverlay()
  },
  lineup: () => void enterLineup(),
  materialManager: (on) => {
    if (on === undefined) toggleMgr()
    else if (on && !mgrMode) enterMgr()
    else if (!on && mgrMode) exitMgr()
    return mgrMode
  },
  selectMaterial: (id) => {
    if (!mgrMode) enterMgr()
    selectMaterial(id)
  },
  bounds: () => {
    const g = mgrMode && mgrPreview ? mgrPreview.spin : sel?.built?.group
    if (!g) return null
    const b = new THREE.Box3().setFromObject(g)
    const size = b.getSize(new THREE.Vector3())
    return { min: b.min.toArray(), max: b.max.toArray(), size: size.toArray().map((v) => +v.toFixed(3)) }
  },
  cam: (az, el, dist) => {
    // in manager mode, drive the dedicated preview camera; otherwise the entity vp
    const a = THREE.MathUtils.degToRad(az)
    const e = THREE.MathUtils.degToRad(el)
    if (mgrMode && mgrPreview) {
      const box = new THREE.Box3().setFromObject(mgrPreview.spin)
      const c = box.getCenter(new THREE.Vector3())
      const r = dist ?? Math.max(box.getSize(new THREE.Vector3()).length() * 1.1, 1.5)
      mgrPreview.controls.target.copy(c)
      mgrPreview.camera.position.set(
        c.x + r * Math.cos(e) * Math.sin(a),
        c.y + r * Math.sin(e),
        c.z + r * Math.cos(e) * Math.cos(a),
      )
      mgrPreview.controls.update()
      return
    }
    const box = sel?.built?.bounds
    if (!box) return
    const c = box.getCenter(new THREE.Vector3())
    const r = dist ?? box.getSize(new THREE.Vector3()).length() * 1.2
    vp.controls.target.copy(c)
    vp.camera.position.set(
      c.x + r * Math.cos(e) * Math.sin(a),
      c.y + r * Math.sin(e),
      c.z + r * Math.cos(e) * Math.cos(a),
    )
    vp.controls.update()
  },
  wire: (on) => {
    // debug: wireframe toggle — same state as the topbar button, so it
    // persists across rebuilds while active
    wireOn = on
    applyWire()
  },
  lights: (params) => {
    // #31: getter/setter for the viewport lights (tests + scripting).
    if (params === 'reset') return vp.resetLights()
    return params ? vp.setLights(params) : vp.getLights()
  },
  ids: () => ({
    entities: [...inv.entities.keys()],
    effects: [...inv.effects.keys()],
    sfx: [...inv.sfx.keys()],
  }),
  meshes: () =>
    sel?.built?.meshes.map((m) => ({
      node: m.userData.nodeName as string,
      visible: m.visible,
      worldScale: m.getWorldScale(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)),
      mats: (Array.isArray(m.material) ? m.material : [m.material]).map(
        (x) => `${x.name}#${(x as THREE.MeshStandardMaterial).color?.getHexString?.() ?? '??'}`,
      ),
    })) ?? [],
}

// Only reload for code THIS page runs — and never while slot edits are unsaved.
scopeHmrReloads(['src/editor/', 'src/inventory/', 'src/lib/'], () => {
  if (sel?.dirty || mgrDirty) {
    toast('editor code updated — save (Ctrl+S), then refresh to pick it up')
    return 'unsaved changes'
  }
  return true
})

void boot()
