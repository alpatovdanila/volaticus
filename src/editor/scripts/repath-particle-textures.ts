// repath-particle-textures.ts — the particle sprite/flipbook textures moved from
// the old `vanilla/textures/particle/` root to `resources/particle/`. Rewrite every
// effect burst's `sprite` and `flipbook.pattern` to the new root. Two sprites have
// no file at the new location, so they get the closest existing substitute:
//   angry.png     → generic_0.png  (soft pop puff; the red sparks already read "angry")
//   drip_fall.png → splash_0.png   (water droplet)
// The validator (`npm run check`) confirms every resolved frame exists.
//
//   npx tsx scripts/repath-particle-textures.ts [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EFFECTS = path.join(ROOT, 'inventory', 'effects')
const DRY = process.argv.includes('--dry')

const FROM = 'vanilla/textures/particle/'
const TO = 'particle/'
// substitutions keyed by the post-repath path (files absent under resources/particle)
const SUBS: Record<string, string> = {
  'particle/angry.png': 'particle/generic_0.png',
  'particle/drip_fall.png': 'particle/splash_0.png',
}

const fix = (p: unknown): unknown => {
  if (typeof p !== 'string') return p
  const swapped = p.startsWith(FROM) ? TO + p.slice(FROM.length) : p
  return SUBS[swapped] ?? swapped
}

let changed = 0
for (const f of fs.readdirSync(EFFECTS).filter((f) => f.endsWith('.json'))) {
  const file = path.join(EFFECTS, f)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const before = JSON.stringify(doc)
  for (const burst of doc.particles ?? []) {
    if (burst.sprite !== undefined) burst.sprite = fix(burst.sprite)
    if (burst.flipbook?.pattern !== undefined) burst.flipbook.pattern = fix(burst.flipbook.pattern)
  }
  if (JSON.stringify(doc) !== before) {
    if (!DRY) fs.writeFileSync(file, stringifyPretty(doc))
    changed++
    console.log(`  ${f}`)
  }
}
console.log(`${DRY ? '[dry] ' : ''}re-pathed particle textures in ${changed} effect file(s)`)
