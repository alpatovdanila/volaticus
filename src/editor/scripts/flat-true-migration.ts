// One-shot migration (v2 — supersedes the flat:true stamp): shading is now a
// GLOBAL Light-panel choice, not a per-slot key. Strip every `flat` from every
// entity's material slots. Run: npx tsx scripts/flat-true-migration.ts
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { stringifyPretty } from '../src/inventory/json'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const entitiesDir = path.resolve(__dirname, '../inventory/models')
let filesTouched = 0
let keysStripped = 0

for (const id of fs.readdirSync(entitiesDir)) {
  const file = path.join(entitiesDir, id, id + '.json')
  if (!fs.existsSync(file)) continue
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { materials?: Record<string, { flat?: boolean }> }
  if (!doc.materials) continue
  let changed = false
  for (const def of Object.values(doc.materials)) {
    if ('flat' in def) {
      delete def.flat
      keysStripped++
      changed = true
    }
  }
  if (!changed) continue
  fs.writeFileSync(file, stringifyPretty(doc))
  filesTouched++
}

console.log(JSON.stringify({ filesTouched, keysStripped }))
