// reset-materials.ts — MIGRATION (phase 3). Rewrites every entity's `materials`
// block off the OLD packs onto the new PBR catalog: each slot's legacy `texture`
// is replaced by a catalog `material` id chosen by keyword heuristic from the old
// texture path + slot name + tint, so models stay sensible. Preserves the
// geometric/placement overrides (tint, uvMode, uvScale, uvRot, flat) and DROPS the
// retired keys (surface, opacity, cutout, doubleSided, emissive, noise, roughness,
// metalness). Touches ONLY the materials block — rig/anims/states/physics/props/
// variants/events are left byte-identical. Idempotent: a slot already on `material`
// is left alone. Saves via stringifyPretty.
//
//   npx tsx scripts/reset-materials.ts
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INV = path.join(ROOT, 'inventory')
const MATERIALS_DIR = path.join(INV, 'materials')
const ENTITY_DIRS = ['props', 'pickups', 'enemies', 'characters', 'levelparts']

// catalog ids actually present (guards the heuristic against typos).
const catalogIds = new Set(
  fs
    .readdirSync(MATERIALS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, '')),
)
function pick(id: string): string {
  if (!catalogIds.has(id)) throw new Error(`heuristic chose non-existent catalog id "${id}"`)
  return id
}

const NEUTRAL = 'plaster_wall_01' // default for tinted-neutral / unclassifiable slots

// Choose a catalog material id from the old texture path + slot name + tint.
// The old data leans on white_concrete + a tint for organic/character parts, so
// those fall through to a smooth neutral (plaster) and let the preserved tint
// carry the colour — same visual intent, now a real material.
function chooseMaterial(slot: string, texture: string, _tint: string | undefined): string {
  const t = texture.toLowerCase()
  const s = slot.toLowerCase()
  const hay = `${t} ${s}`

  const any = (...words: string[]) => words.some((w) => hay.includes(w))

  // --- leaves / foliage / crops → grass family -----------------------------
  if (any('leaves', 'leaf', 'needle', 'foliage', 'bush', 'moss', 'wheat', 'carrot', 'stem', 'crop', 'grass'))
    return pick('grass_01')

  // --- roofs (before wood/stone, roofs are their own family) ---------------
  if (any('roof', 'nether_bricks', 'red_nether')) {
    if (any('slate', 'copper', 'tiles')) return pick('roof_tiles_01')
    if (any('wood', 'shingle')) return pick('wooden_roof_tiles_01')
    if (any('hay', 'thatch', 'straw')) return pick('hay_roof_01')
    return pick('roof_tiles_01')
  }

  // --- metal / iron / gold / bands -----------------------------------------
  if (any('iron', 'gold', 'metal', 'band', 'strap', 'blade', 'hammer', 'chrome', 'anvil')) {
    if (any('gold')) return pick('metal_02')
    if (any('chrome', 'polished_black', 'blade', 'hammer')) return pick('metal_pattern_01')
    return pick('metal_01')
  }

  // --- timber framing (half-timbered houses) -------------------------------
  if (s.includes('timber')) return pick('tudor_wall_01')

  // --- wood: planks / logs / bark / posts / fences -------------------------
  if (any('plank', 'planks')) return pick('wood_planks_01')
  if (any('log', 'bark', 'stripped', 'spruce', 'birch', 'oak', 'jungle', 'acacia', 'dark_oak')) {
    if (any('bark') || s === 'bark') return pick('bark_01')
    return pick('wood_log_01')
  }
  if (any('wood', 'post', 'fence', 'board', 'bench', 'hilt', 'door', 'panel', 'frame', 'fuse', 'rope')) {
    if (any('post', 'fence', 'log')) return pick('wood_log_01')
    return pick('wood_planks_01')
  }

  // --- stone / rock / brick / cobble ---------------------------------------
  if (any('cobble', 'cobblestone')) return pick('cobblestone_01')
  if (any('brick', 'stone_bricks', 'deepslate')) return pick('bricks_wall_01')
  if (any('cracked_stone', 'stone_brick')) return pick('stone_bricks_wall_02')
  if (any('rock', 'cliff', 'gravel', 'boulder')) return pick('cliff_rocks_01')
  if (any('stone', 'blackstone', 'coal', 'deepslate')) return pick('stone_wall_01')

  // --- plaster / concrete / white walls ------------------------------------
  if (any('plaster')) return pick('plaster_wall_01')
  if (any('concrete', 'white', 'wool', 'terracotta', 'glazed', 'shulker')) return pick(NEUTRAL)

  // --- dirt / soil / sand / ground -----------------------------------------
  if (any('sand')) return pick('sand_01')
  if (any('dirt', 'soil', 'farmland', 'ground', 'soul_soil', 'tilled')) return pick('ground_01')

  return pick(NEUTRAL)
}

// slot keys that survive migration (geometric/placement overrides).
const KEEP = new Set(['material', 'tint', 'uvMode', 'uvScale', 'uvRot', 'flat'])

type Slot = Record<string, unknown>

// Rewrite one slot. Idempotent: if it already references a catalog material,
// only strip any retired keys that snuck in (keeps the KEEP set).
function migrateSlot(slot: string, m: Slot): { out: Slot; chosen: string | null } {
  const out: Slot = {}
  let chosen: string | null = null
  if (typeof m.material === 'string' && m.material) {
    // already migrated — carry the material + preserve/keep overrides only.
    out.material = m.material
  } else {
    const tex = typeof m.texture === 'string' ? m.texture : ''
    const tint = typeof m.tint === 'string' ? m.tint : undefined
    chosen = chooseMaterial(slot, tex, tint)
    out.material = chosen
  }
  // preserved overrides in a stable order (material first, then the rest).
  for (const k of ['tint', 'uvMode', 'uvScale', 'uvRot', 'flat']) if (k in m && KEEP.has(k)) out[k] = m[k]
  return { out, chosen }
}

let filesChanged = 0
const report: string[] = []

for (const dir of ENTITY_DIRS) {
  const full = path.join(INV, dir)
  if (!fs.existsSync(full)) continue
  for (const file of fs.readdirSync(full)) {
    if (!file.endsWith('.json')) continue
    const p = path.join(full, file)
    const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>
    const materials = doc.materials as Record<string, Slot> | undefined
    if (!materials) continue
    const next: Record<string, Slot> = {}
    const picks: string[] = []
    for (const [slot, m] of Object.entries(materials)) {
      const { out, chosen } = migrateSlot(slot, m)
      next[slot] = out
      if (chosen) picks.push(`${slot}→${chosen}`)
    }
    doc.materials = next
    const before = fs.readFileSync(p, 'utf-8')
    const after = stringifyPretty(doc)
    if (before !== after) {
      fs.writeFileSync(p, after)
      filesChanged++
      report.push(`${dir}/${file}: ${picks.join(', ') || '(already migrated)'}`)
    }
  }
}

console.log(`reset ${filesChanged} entity file(s).`)
for (const line of report) console.log('  ' + line)
