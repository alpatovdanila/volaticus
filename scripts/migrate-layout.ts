// migrate-layout.ts — flatten the entity category folders into a single
// inventory/entities/<id>/<id>.json layout.
//
// The category subfolders (props/enemies/characters/pickups/levelparts) were
// redundant with the `category` field in each JSON — the studio's item list
// already groups by that field, and no live code keys off the folder name. The
// per-entity folder makes room for the baked <id>.geom.{i}.json files (phase 2).
// effects/ · sfx/ · materials/ stay flat (they carry no rig geometry).
//
//   npx tsx scripts/migrate-layout.ts [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INV = path.join(ROOT, 'inventory')
const ENTITIES = path.join(INV, 'entities')
const CATEGORY_DIRS = ['props', 'enemies', 'characters', 'pickups', 'levelparts']
const DRY = process.argv.includes('--dry')

let moved = 0
for (const cat of CATEGORY_DIRS) {
  const dir = path.join(INV, cat)
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const id = f.replace(/\.json$/, '')
    const destDir = path.join(ENTITIES, id)
    if (!DRY) {
      fs.mkdirSync(destDir, { recursive: true })
      fs.renameSync(path.join(dir, f), path.join(destDir, f))
    }
    console.log(`  ${cat}/${f} -> entities/${id}/${f}`)
    moved++
  }
  if (!DRY && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
}
console.log(`${DRY ? '[dry] ' : ''}moved ${moved} entity file(s) into inventory/entities/<id>/`)
