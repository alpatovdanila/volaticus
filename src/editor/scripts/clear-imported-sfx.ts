// clear-imported-sfx.ts — delete every SAMPLE-BASED ("imported") sfx and remove
// all references to it across the inventory. Synth sfx (with `layers`) are kept.
//
// An imported sfx has a `files` array (external sample paths); a synth sfx has
// `layers`. References live only in entity bindings (states.*.enter, states.*.cues,
// states.*.ambient, events.*) and in effect docs (`sfx`: string | string[]).
// Removing a ref that leaves an empty binding / cue / event / byContext override
// prunes it; an `ambient` block (schema REQUIRES its sfx) is removed whole. Named
// states are never pruned (an empty state is a legal, intentional thing).
//
// The validator (`npm run check`) is the completeness guarantee: any surviving
// reference to a deleted sfx becomes an "unknown sfx" error there.
//
//   npx tsx scripts/clear-imported-sfx.ts [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INV = path.join(ROOT, 'inventory')
const DRY = process.argv.includes('--dry')

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const isEmpty = (v: unknown): boolean => isObj(v) && Object.keys(v).length === 0

function walkJson(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJson(p))
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

// 1. collect the imported (sample-based) sfx ids.
const removed = new Set<string>()
for (const f of fs.readdirSync(path.join(INV, 'sfx')).filter((f) => f.endsWith('.json'))) {
  const doc = JSON.parse(fs.readFileSync(path.join(INV, 'sfx', f), 'utf8'))
  if (Array.isArray(doc.files)) removed.add(doc.id ?? f.replace(/\.json$/, ''))
}
console.log(`imported sfx to clear (${removed.size}): ${[...removed].sort().join(', ')}`)

// remove `sfx` from a binding + its byContext overrides; prune emptied overrides.
function cleanBinding(b: any): void {
  if (!isObj(b)) return
  if (typeof b.sfx === 'string' && removed.has(b.sfx)) delete b.sfx
  const bc = b.byContext
  if (isObj(bc)) {
    for (const k of Object.keys(bc)) {
      const o = bc[k]
      if (isObj(o) && typeof o.sfx === 'string' && removed.has(o.sfx)) delete o.sfx
      if (isEmpty(o)) delete bc[k]
    }
    if (isEmpty(bc)) delete b.byContext
  }
}

let entityChanges = 0
let effectChanges = 0
for (const file of walkJson(INV)) {
  const rel = path.relative(INV, file).replace(/\\/g, '/')
  if (rel === 'settings.json' || rel.startsWith('materials/') || rel.startsWith('sfx/')) continue
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const before = JSON.stringify(doc)

  if (rel.startsWith('effects/')) {
    if (typeof doc.sfx === 'string' && removed.has(doc.sfx)) delete doc.sfx
    else if (Array.isArray(doc.sfx)) {
      doc.sfx = doc.sfx.filter((s: string) => !removed.has(s))
      if (doc.sfx.length === 0) delete doc.sfx
    }
    if (JSON.stringify(doc) !== before) {
      if (!DRY) fs.writeFileSync(file, stringifyPretty(doc))
      effectChanges++
    }
    continue
  }

  // entity (characters / enemies / props / pickups / levelparts)
  if (isObj(doc.states)) {
    for (const [sName, s] of Object.entries<any>(doc.states)) {
      if (sName === 'initial' || !isObj(s)) continue
      if (s.enter) {
        cleanBinding(s.enter)
        if (isEmpty(s.enter)) delete s.enter
      }
      if (isObj(s.cues)) {
        for (const t of Object.keys(s.cues)) {
          cleanBinding(s.cues[t])
          if (isEmpty(s.cues[t])) delete s.cues[t]
        }
        if (isEmpty(s.cues)) delete s.cues
      }
      // ambient carries a REQUIRED sfx — drop the whole block if that sfx is going.
      if (isObj(s.ambient) && typeof s.ambient.sfx === 'string' && removed.has(s.ambient.sfx)) delete s.ambient
    }
  }
  if (isObj(doc.events)) {
    for (const ev of Object.keys(doc.events)) {
      cleanBinding(doc.events[ev])
      if (isEmpty(doc.events[ev])) delete doc.events[ev]
    }
    if (isEmpty(doc.events)) delete doc.events
  }

  if (JSON.stringify(doc) !== before) {
    if (!DRY) fs.writeFileSync(file, stringifyPretty(doc))
    entityChanges++
  }
}

// 2. delete the imported sfx files.
let deleted = 0
for (const f of fs.readdirSync(path.join(INV, 'sfx')).filter((f) => f.endsWith('.json'))) {
  const id = f.replace(/\.json$/, '')
  if (removed.has(id)) {
    if (!DRY) fs.unlinkSync(path.join(INV, 'sfx', f))
    deleted++
  }
}

console.log(
  `${DRY ? '[dry] ' : ''}deleted ${deleted} sfx file(s); dereferenced in ${entityChanges} entity + ${effectChanges} effect file(s)`,
)
