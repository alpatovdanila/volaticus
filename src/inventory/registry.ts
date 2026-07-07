// Client-side inventory: loads every JSON under inventory/ via the dev API,
// validates it, and polls mtimes so prompt-driven file edits appear live.
import {
  crossCheckEntity,
  crossCheckEffect,
  crossCheckMaterialCatalog,
  crossCheckSfx,
  SurfaceSchema,
  validateEffect,
  validateEntity,
  validateMaterialCatalog,
  validateSfx,
  type CrossContext,
  type EffectDoc,
  type EntityDoc,
  type MaterialCatalogDoc,
  type SfxDoc,
  type SurfaceDef,
} from './schema'

export type ItemKind = 'entity' | 'effect' | 'sfx' | 'material'

export interface Item<T> {
  kind: ItemKind
  id: string
  path: string
  mtime: number
  raw: unknown
  doc?: T
  issues: string[]
}

export interface Settings {
  texturePack: string
  surfaces: Record<string, SurfaceDef> // named gloss/metal/env presets for materials
}

export const SETTINGS_PATH = 'settings.json'

export function kindOfPath(path: string): ItemKind {
  if (path.startsWith('effects/')) return 'effect'
  if (path.startsWith('sfx/')) return 'sfx'
  if (path.startsWith('materials/')) return 'material'
  return 'entity'
}

const idOfPath = (path: string) => path.split('/').pop()!.replace(/\.json$/, '')

export class Inventory {
  entities = new Map<string, Item<EntityDoc>>()
  effects = new Map<string, Item<EffectDoc>>()
  sfx = new Map<string, Item<SfxDoc>>()
  materials = new Map<string, Item<MaterialCatalogDoc>>()
  textures: string[] = []
  packs: string[] = ['vanilla']
  settings: Settings = { texturePack: 'vanilla', surfaces: {} }
  settingsRaw: Record<string, unknown> = { format: 1, texturePack: 'vanilla' } // full file — saves must not drop unknown keys
  private settingsMtime = 0
  private textureSet = new Set<string>()
  private animatedSet = new Set<string>()
  private soundSet = new Set<string>()
  private modelSet = new Set<string>()
  private byPath = new Map<string, { kind: ItemKind; id: string }>()
  private pollTimer: number | undefined // dev hot-reload poll (idempotent)
  onChanged = new Set<(paths: string[]) => void>()

  hasTexture(path: string): boolean {
    return this.textureSet.has(path)
  }

  // resources audio paths (.wav/.ogg/.mp3) discovered under resources/ — the
  // sound-zone music picker lists these; hasSound() validates a chosen path.
  hasSound(path: string): boolean {
    return this.soundSet.has(path)
  }
  soundPaths(): string[] {
    return [...this.soundSet].sort()
  }

  // id -> validated catalog doc, for setMaterialCatalog (materials.ts runtime).
  materialCatalog(): Record<string, MaterialCatalogDoc> {
    const out: Record<string, MaterialCatalogDoc> = {}
    for (const [id, item] of this.materials) if (item.doc) out[id] = item.doc
    return out
  }

  async load(): Promise<void> {
    const [inv, tex] = await Promise.all([
      fetch('/__inv/list').then((r) => r.json()),
      fetch('/__textures').then((r) => r.json()),
    ])
    this.textures = tex.textures
    this.textureSet = new Set(this.textures)
    this.animatedSet = new Set(tex.animated ?? [])
    this.soundSet = new Set(tex.sounds ?? [])
    this.modelSet = new Set(tex.models ?? [])
    this.packs = tex.packs?.length ? tex.packs : ['vanilla']
    await Promise.all(inv.items.map((it: { path: string; mtime: number }) => this.fetchFile(it.path)))
    this.crossValidate()
  }

  private async fetchFile(path: string): Promise<void> {
    const res = await fetch('/__inv/read?path=' + encodeURIComponent(path))
    if (!res.ok) return
    const { mtime, content } = await res.json()
    this.applyFile(path, mtime, content)
  }

  applyFile(path: string, mtime: number, content: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch (e) {
      raw = null
    }
    if (path === SETTINGS_PATH) {
      const r = (raw ?? {}) as { texturePack?: unknown; surfaces?: unknown }
      const surfaces: Record<string, SurfaceDef> = {}
      if (r.surfaces && typeof r.surfaces === 'object')
        for (const [name, def] of Object.entries(r.surfaces as Record<string, unknown>)) {
          const parsed = SurfaceSchema.safeParse(def)
          if (parsed.success) surfaces[name] = parsed.data
        }
      this.settings = {
        texturePack: typeof r.texturePack === 'string' ? r.texturePack : 'vanilla',
        surfaces,
      }
      this.settingsRaw = (raw && typeof raw === 'object' ? raw : { format: 1 }) as Record<string, unknown>
      this.settingsMtime = mtime
      return
    }
    const kind = kindOfPath(path)
    const id = idOfPath(path)
    const base = { kind, id, path, mtime, raw }
    if (raw === null) {
      const item = { ...base, issues: ['file is not valid JSON'] }
      this.mapFor(kind).set(id, item as never)
    } else if (kind === 'entity') {
      const v = validateEntity(raw)
      this.entities.set(id, { ...base, kind, doc: v.doc, issues: v.issues })
    } else if (kind === 'effect') {
      const v = validateEffect(raw)
      this.effects.set(id, { ...base, kind, doc: v.doc, issues: v.issues })
    } else if (kind === 'material') {
      const v = validateMaterialCatalog(raw)
      this.materials.set(id, { ...base, kind, doc: v.doc, issues: v.issues })
    } else {
      const v = validateSfx(raw)
      this.sfx.set(id, { ...base, kind, doc: v.doc, issues: v.issues })
    }
    this.byPath.set(path, { kind, id })
    const declaredId = (raw as { id?: string } | null)?.id
    if (declaredId && declaredId !== id)
      this.mapFor(kind).get(id)?.issues.push(`id "${declaredId}" does not match filename "${id}"`)
  }

  private mapFor(kind: ItemKind): Map<string, Item<unknown>> {
    return (
      kind === 'entity'
        ? this.entities
        : kind === 'effect'
          ? this.effects
          : kind === 'material'
            ? this.materials
            : this.sfx
    ) as Map<string, Item<unknown>>
  }

  crossValidate(): void {
    const ctx: CrossContext = {
      hasTexture: (p) => this.textureSet.has(p),
      isAnimatedTexture: (p) => this.animatedSet.has(p),
      hasSound: (p) => this.soundSet.has(p),
      hasModel: (p) => this.modelSet.has(p),
      hasEffect: (id) => this.effects.has(id),
      hasSfx: (id) => this.sfx.has(id),
      hasSurface: (name) => name in this.settings.surfaces,
      hasMaterial: (id) => this.materials.has(id),
    }
    for (const item of this.entities.values())
      if (item.doc) {
        item.issues = item.issues.filter((i) => !i.startsWith('[ref]'))
        item.issues.push(...crossCheckEntity(item.doc, ctx).map((i) => '[ref] ' + i))
      }
    for (const item of this.effects.values())
      if (item.doc) {
        item.issues = item.issues.filter((i) => !i.startsWith('[ref]'))
        item.issues.push(...crossCheckEffect(item.doc, ctx).map((i) => '[ref] ' + i))
      }
    for (const item of this.sfx.values())
      if (item.doc) {
        item.issues = item.issues.filter((i) => !i.startsWith('[ref]'))
        item.issues.push(...crossCheckSfx(item.doc, ctx).map((i) => '[ref] ' + i))
      }
    for (const item of this.materials.values())
      if (item.doc) {
        item.issues = item.issues.filter((i) => !i.startsWith('[ref]'))
        item.issues.push(...crossCheckMaterialCatalog(item.doc, ctx).map((i) => '[ref] ' + i))
      }
  }

  async save(path: string, content: string): Promise<void> {
    const res = await fetch('/__inv/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    })
    if (!res.ok) throw new Error('save failed: ' + (await res.text()))
    const { mtime } = await res.json()
    if (path === SETTINGS_PATH) {
      this.settingsMtime = mtime
      return
    }
    const ref = this.byPath.get(path)
    if (ref) {
      const item = this.mapFor(ref.kind).get(ref.id)
      if (item) item.mtime = mtime // so polling doesn't treat our own save as an external change
    }
  }

  // #16: delete a file via the dev API and drop it from the in-memory maps
  // immediately (polling would catch it too, but this keeps the UI instant).
  async delete(path: string): Promise<void> {
    const res = await fetch('/__inv/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) throw new Error('delete failed: ' + (await res.text()))
    const ref = this.byPath.get(path)
    if (ref) {
      this.mapFor(ref.kind).delete(ref.id)
      this.byPath.delete(path)
    }
    this.crossValidate()
  }

  // Dev-only hot-reload poll: watches the inventory for EXTERNAL file edits and
  // fetches the changed ones. Costs a full /__inv/list fetch + a scan of every file
  // each tick, so keep it cheap: idempotent (never stack pollers), skip while the
  // tab is hidden, and — crucially — skip while the user is dragging so the scan
  // never stutters a frame mid-orbit.
  startPolling(intervalMs = 3000): void {
    if (this.pollTimer !== undefined) return // already polling — don't stack
    let busy = false
    let lastInteract = 0
    if (typeof addEventListener === 'function') {
      // Any camera interaction: pointer-down, a drag (pointermove with a button held),
      // or wheel-zoom. The 1200ms defer window below then also covers OrbitControls'
      // damping tail (~1s of continued motion AFTER release, when no button is held) —
      // that tail was the residual rotate-stutter.
      const bump = () => { lastInteract = performance.now() }
      addEventListener('pointerdown', bump, { passive: true })
      addEventListener('pointermove', (e) => { if ((e as PointerEvent).buttons) bump() }, { passive: true })
      addEventListener('wheel', bump, { passive: true })
    }
    this.pollTimer = window.setInterval(async () => {
      if (busy) return
      if (typeof document !== 'undefined' && document.hidden) return
      if (performance.now() - lastInteract < 1200) return // interacting + damping tail — defer
      busy = true
      try {
        const res = await fetch('/__inv/list')
        const { items } = (await res.json()) as { items: { path: string; mtime: number }[] }
        const changed: string[] = []
        const seen = new Set<string>()
        for (const it of items) {
          seen.add(it.path)
          let curMtime: number | undefined
          if (it.path === SETTINGS_PATH) {
            curMtime = this.settingsMtime || undefined
          } else {
            const known = this.byPath.get(it.path)
            curMtime = known ? this.mapFor(known.kind).get(known.id)?.mtime : undefined
          }
          if (curMtime === undefined || Math.abs(curMtime - it.mtime) > 0.5) {
            await this.fetchFile(it.path)
            changed.push(it.path)
          }
        }
        for (const [path, ref] of [...this.byPath]) {
          if (!seen.has(path)) {
            this.mapFor(ref.kind).delete(ref.id)
            this.byPath.delete(path)
            changed.push(path)
          }
        }
        if (changed.length) {
          this.crossValidate()
          for (const cb of this.onChanged) cb(changed)
        }
      } catch {
        // dev server briefly unavailable — retry next tick
      } finally {
        busy = false
      }
    }, intervalMs)
  }
}
