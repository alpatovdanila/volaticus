// One-off: pin a stored variant set (variants.seeds) on every entity that has
// a variants block. Seeds derive from the id, so results are stable per file.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INV = path.join(ROOT, 'inventory')
const COUNT = 6

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) % 1_000_000_000
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

for (const file of walk(INV)) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!d.variants || d.variants.seeds) continue
  d.variants.seeds = Array.from({ length: COUNT }, (_, i) => hash(d.id + ':' + i))
  fs.writeFileSync(file, stringifyPretty(d))
  console.log(`seeded ${path.relative(ROOT, file)} (${COUNT} variants)`)
}
