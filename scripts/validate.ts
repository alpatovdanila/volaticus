// npm run check — validates every inventory file: schema shape, internal refs
// (nodes/anims/slots), cross-file refs (sfx/effects) and texture existence.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  crossCheckEntity,
  crossCheckEffect,
  crossCheckMaterialCatalog,
  crossCheckSfx,
  validateEffect,
  validateEntity,
  validateMaterialCatalog,
  validateSfx,
  type CrossContext,
} from '../src/inventory/schema'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INV = path.join(ROOT, 'inventory')
const RES = path.join(ROOT, 'resources')

function walk(dir: string, ext: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, ext, base))
    else if (e.name.endsWith(ext)) out.push(path.relative(base, p).replace(/\\/g, '/'))
  }
  return out
}

// *.geom.{i}.json (geometry) + *.variants.json (layouts) are baked sidecars, not inventory items.
const files = walk(INV, '.json').filter((p) => !/\.(geom\.\d+|variants)\.json$/.test(p))
// .png for the minecraft packs + legacy slots; .jpg for a few freestylized catalog
// maps; .ktx2 for the compressed PBR catalog (mirrors the dev API's /__textures listing).
const textures = new Set([...walk(RES, '.png'), ...walk(RES, '.jpg'), ...walk(RES, '.ktx2')])
const animated = new Set(walk(RES, '.png.mcmeta').map((p) => p.replace(/\.mcmeta$/, '')))
const sounds = new Set([...walk(RES, '.wav'), ...walk(RES, '.ogg'), ...walk(RES, '.mp3'), ...walk(RES, '.flac')])
const models = new Set([...walk(RES, '.fbx'), ...walk(RES, '.glb')])
const surfaces = new Set<string>()
try {
  const s = JSON.parse(fs.readFileSync(path.join(INV, 'settings.json'), 'utf8'))
  for (const name of Object.keys(s.surfaces ?? {})) surfaces.add(name)
} catch {
  // settings issues are reported in the per-file loop below
}

interface Loaded {
  path: string
  kind: 'entity' | 'effect' | 'sfx' | 'material'
  id: string
  issues: string[]
  doc?: unknown
}

const items: Loaded[] = []
for (const rel of files) {
  if (rel === 'settings.json') {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(INV, rel), 'utf8'))
      const pack = String(s.texturePack ?? 'vanilla')
      if (!fs.existsSync(path.join(RES, pack, 'textures')))
        items.push({ path: rel, kind: 'sfx', id: 'settings', issues: [`texturePack "${pack}" has no textures/ dir under resources/`] })
      else console.log(`✓ settings.json (pack: ${pack})`)
    } catch (e) {
      items.push({ path: rel, kind: 'sfx', id: 'settings', issues: ['invalid JSON: ' + String(e)] })
    }
    continue
  }
  const id = rel.split('/').pop()!.replace(/\.json$/, '')
  const kind = rel.startsWith('effects/')
    ? 'effect'
    : rel.startsWith('sfx/')
      ? 'sfx'
      : rel.startsWith('materials/')
        ? 'material'
        : 'entity'
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(INV, rel), 'utf8'))
  } catch (e) {
    items.push({ path: rel, kind, id, issues: ['invalid JSON: ' + String(e)] })
    continue
  }
  const v =
    kind === 'entity'
      ? validateEntity(raw)
      : kind === 'effect'
        ? validateEffect(raw)
        : kind === 'material'
          ? validateMaterialCatalog(raw)
          : validateSfx(raw)
  const issues = [...v.issues]
  const declaredId = (raw as { id?: string }).id
  if (declaredId !== id) issues.push(`id "${declaredId}" does not match filename "${id}"`)
  items.push({ path: rel, kind, id, issues, doc: v.doc })
}

const effectIds = new Set(items.filter((i) => i.kind === 'effect' && i.doc).map((i) => i.id))
const sfxIds = new Set(items.filter((i) => i.kind === 'sfx' && i.doc).map((i) => i.id))
const materialIds = new Set(items.filter((i) => i.kind === 'material' && i.doc).map((i) => i.id))
const ctx: CrossContext = {
  hasTexture: (p) => textures.has(p),
  isAnimatedTexture: (p) => animated.has(p),
  hasSound: (p) => sounds.has(p),
  hasModel: (p) => models.has(p),
  hasEffect: (id) => effectIds.has(id),
  hasSfx: (id) => sfxIds.has(id),
  hasSurface: (name) => surfaces.has(name),
  hasMaterial: (id) => materialIds.has(id),
}

for (const item of items) {
  if (!item.doc) continue
  if (item.kind === 'entity') item.issues.push(...crossCheckEntity(item.doc as never, ctx))
  if (item.kind === 'effect') item.issues.push(...crossCheckEffect(item.doc as never, ctx))
  if (item.kind === 'sfx') item.issues.push(...crossCheckSfx(item.doc as never, ctx))
  if (item.kind === 'material') item.issues.push(...crossCheckMaterialCatalog(item.doc as never, ctx))
}

let bad = 0
for (const item of items.sort((a, b) => a.path.localeCompare(b.path))) {
  if (item.issues.length) {
    bad++
    console.log(`✗ ${item.path}`)
    for (const i of item.issues) console.log(`    - ${i}`)
  } else {
    console.log(`✓ ${item.path}`)
  }
}
console.log(`\n${items.length} files, ${items.length - bad} valid, ${bad} with issues (${textures.size} textures indexed)`)


if (bad > 0) process.exit(1)
