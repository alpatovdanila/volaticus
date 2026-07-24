// migrate-events.ts — event/reaction model refactor (one-off):
//   • behavior "destructible" → "dynamic"  (destructibility is a runtime decision)
//   • binding `despawn: true` → `hideGeometry: true`  (a reaction hide, not removal)
//   • binding `shatter: true` → `effect: "SCRIPT_EFFECT_SHATTER"`  (reserved script
//     effect; the chosen placement REUSES the effect field, so it replaces any
//     existing effect in that same binding)
//
// shatter/despawn only ever appear inside reaction bindings (states.*.enter/cues,
// events.*, byContext overrides), so a recursive key-scan is safe. The state-level
// `despawnAfter` field is a different key and is left untouched.
//
//   npx tsx scripts/migrate-events.ts [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INV = path.join(ROOT, 'inventory')
const DRY = process.argv.includes('--dry')
const ENTITY_DIRS = ['characters', 'enemies', 'props', 'pickups', 'levelparts']

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

// migrate one binding-shaped object in place, then recurse into its values.
function migrate(node: any): void {
  if (Array.isArray(node)) {
    for (const v of node) migrate(v)
    return
  }
  if (!isObj(node)) return
  if (node.shatter === true) node.effect = 'SCRIPT_EFFECT_SHATTER' // reuse-effect-field placement
  if ('shatter' in node) delete node.shatter
  if ('despawn' in node) {
    node.hideGeometry = node.despawn
    delete node.despawn
  }
  for (const v of Object.values(node)) migrate(v)
}

let changed = 0
for (const dir of ENTITY_DIRS) {
  const d = path.join(INV, dir)
  if (!fs.existsSync(d)) continue
  for (const f of fs.readdirSync(d).filter((f) => f.endsWith('.json'))) {
    const file = path.join(d, f)
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const before = JSON.stringify(doc)
    if (doc.behavior === 'destructible') doc.behavior = 'dynamic'
    migrate(doc)
    if (JSON.stringify(doc) !== before) {
      if (!DRY) fs.writeFileSync(file, stringifyPretty(doc))
      changed++
      console.log(`  ${dir}/${f}`)
    }
  }
}
console.log(`${DRY ? '[dry] ' : ''}migrated ${changed} entity file(s)`)
