// remap-mc-materials.ts — repoint every entity material slot that references a
// (now-deleted) minecraft catalog material `mc_*` to a single PBR substitute:
// concrete_wall_01, the whitest concrete in the catalog. The per-slot `tint` on
// those slots is stripped too, since those tints were picked for the old
// minecraft textures — leaving them would give tinted, not white, concrete. All
// other per-slot props (uvMode/uvScale/uvRot/uvProject/flat/inherit) are kept.
//
//   npx tsx scripts/remap-mc-materials.ts [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INV = path.join(ROOT, 'inventory')
const TARGET = 'concrete_wall_01'
const DRY = process.argv.includes('--dry')

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function walkJson(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJson(p))
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

let slotsRemapped = 0
const perFile: string[] = []
for (const file of walkJson(INV)) {
  const rel = path.relative(INV, file).replace(/\\/g, '/')
  if (rel === 'settings.json' || rel.startsWith('materials/') || rel.startsWith('sfx/') || rel.startsWith('effects/')) continue
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!isObj(doc.materials)) continue
  const before = JSON.stringify(doc)
  let n = 0
  for (const def of Object.values<any>(doc.materials)) {
    if (isObj(def) && typeof def.material === 'string' && def.material.startsWith('mc_')) {
      def.material = TARGET
      delete def.tint // strip minecraft-era tint so it reads as clean white concrete
      n++
    }
  }
  if (JSON.stringify(doc) !== before) {
    if (!DRY) fs.writeFileSync(file, stringifyPretty(doc))
    slotsRemapped += n
    perFile.push(`${rel}: ${n} slot(s)`)
  }
}

console.log(`${DRY ? '[dry] ' : ''}remapped ${slotsRemapped} mc_* slot(s) → ${TARGET} across ${perFile.length} file(s):`)
for (const p of perFile) console.log('  - ' + p)
