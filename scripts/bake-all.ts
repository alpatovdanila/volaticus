// bake-all.ts — phase-2 migration + bake. For every entity under
// inventory/entities/<id>/:
//   1. strip the retired fields from <id>.json: `behavior`, per-node `seed`, and
//      the old variants jitter (`scale`/`yawJitter`/`tiltJitter`/`tintJitter`/`seeds`);
//      reshape `variants` → { count, oneOf } (count carried over from seeds.length).
//   2. write a per-part `craftSeed` into <id>.json, roll `count` variant layouts
//      into <id>.variants.json, and compose <id>.geom.{i}.json from them (compact).
//
// Runs headless — the bake path uses only THREE's geometry math (no renderer) and
// procgeom, so no GL context is needed. (No entity currently uses shape "mesh",
// which would need the FBX loader.)
//
//   npx tsx scripts/bake-all.ts [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'
import { bakeEntityGeometry, bakeVariantLayouts, ensureCraftSeeds } from '../src/inventory/factory'
import type { EntityDoc } from '../src/inventory/schema'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTITIES = path.join(ROOT, 'inventory', 'entities')
const DRY = process.argv.includes('--dry')

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

// drop node.seed everywhere in the rig tree.
function stripNodeSeed(node: any): void {
  if (Array.isArray(node)) return node.forEach(stripNodeSeed)
  if (!isObj(node)) return
  delete node.seed
  for (const v of Object.values(node)) stripNodeSeed(v)
}

let count = 0
let variantsTotal = 0
for (const id of fs.readdirSync(ENTITIES).filter((d) => fs.statSync(path.join(ENTITIES, d)).isDirectory())) {
  const file = path.join(ENTITIES, id, `${id}.json`)
  if (!fs.existsSync(file)) continue
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))

  // 1. clean the entity JSON
  delete raw.behavior
  if (isObj(raw.variants)) {
    const n = Array.isArray(raw.variants.seeds) ? raw.variants.seeds.length : raw.variants.count
    const oneOf = raw.variants.oneOf
    const v: Record<string, unknown> = {}
    if (typeof n === 'number' && n > 1) v.count = n
    if (isObj(oneOf)) v.oneOf = oneOf
    if (Object.keys(v).length) raw.variants = v
    else delete raw.variants
  }
  if (isObj(raw.rig)) stripNodeSeed(raw.rig)

  // 2. seed every shaped part (persists into <id>.json), roll the variant LAYOUTS
  //    (<id>.variants.json), then compose the geom sidecars from seeds + layouts.
  const doc = raw as EntityDoc
  ensureCraftSeeds(doc) // mutates raw — craftSeed lands in the entity JSON
  const layouts = bakeVariantLayouts(doc)
  const baked = bakeEntityGeometry(doc, layouts)
  variantsTotal += baked.length

  if (!DRY) {
    fs.writeFileSync(file, stringifyPretty(raw))
    // remove stale sidecars, then write the fresh layouts + geom set
    for (const f of fs.readdirSync(path.join(ENTITIES, id)))
      if (/\.(geom\.\d+|variants)\.json$/.test(f)) fs.unlinkSync(path.join(ENTITIES, id, f))
    fs.writeFileSync(path.join(ENTITIES, id, `${id}.variants.json`), JSON.stringify({ format: 1, variants: layouts }))
    for (let i = 0; i < baked.length; i++)
      fs.writeFileSync(path.join(ENTITIES, id, `${id}.geom.${i}.json`), JSON.stringify(baked[i]))
  }
  console.log(`  ${id}: ${baked.length} variant(s)`)
  count++
}
console.log(`${DRY ? '[dry] ' : ''}baked ${count} entit${count === 1 ? 'y' : 'ies'} → ${variantsTotal} geom file(s)`)
