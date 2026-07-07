// import-materials.ts — (re)build the PBR material catalog from resources/PBR/.
//
// Scans every resources/PBR/<id>/ folder, classifies its texture files into map
// kinds (robust to the pack's inconsistent naming: color/baseColor, ~7 AO
// spellings, normal_gl preferred over normal_dx, and the couple of mangled
// filenames like `roughness_1kwood_planks_19_.png`), and writes ONE
// inventory/materials/<id>.json per folder — single-resolution maps + a default
// tuning block. Map paths are stored relative to resources/ (e.g. PBR/<id>/..).
//
//   npx tsx scripts/import-materials.ts          # write the files
//   npx tsx scripts/import-materials.ts --dry     # report only, write nothing
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'
import { MAP_KINDS, type MapKind } from '../src/inventory/schema'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PBR = path.join(ROOT, 'resources', 'PBR')
const OUT = path.join(ROOT, 'inventory', 'materials')
const DRY = process.argv.includes('--dry')

// Default tuning written for every imported material — the neutral starting point.
// metalness 0 (dielectric): map-less materials read as normal surfaces; materials
// that ship a metallic map are still driven by the map (metalness = scalar × map).
const DEFAULT_TUNING = {
  tint: null,
  roughness: 1,
  metalness: 0,
  normalScale: 1,
  aoIntensity: 1,
  emissive: 0,
  opacity: 1,
  cutout: false,
  doubleSided: false,
  flat: false,
} as const

// Map-kind keywords, searched as substrings. Robust to the pack's messy naming
// (color/baseColor/basecolo/base, ~7 AO spellings, gl/dx normals).
const KEYWORDS: readonly [MapKind, readonly string[]][] = [
  ['normal', ['normal']],
  ['roughness', ['rough']],
  ['height', ['height', 'displac']],
  ['metallic', ['metallic', 'metal']],
  ['emissive', ['emissi']],
  ['ao', ['occlus', 'occuls', 'occ', 'ambientoc', '_ao']],
  ['color', ['color', 'albedo', 'diffuse', 'base']],
]

// Classify one filename into a map kind by the keyword CLOSEST TO THE END of the
// name. The material id sits at the front and the map token at the back, so
// last-position wins — this survives folder names that themselves contain a
// keyword ("metal_01") and filename typos ("metal_pattren_02") without any
// per-name special-casing.
function classify(file: string): { kind: MapKind; normalKind: 'gl' | 'dx' } | null {
  const f = file.toLowerCase()
  if (!/\.(png|jpe?g)$/.test(f)) return null
  let best: MapKind | null = null
  let bestPos = -1
  for (const [kind, keys] of KEYWORDS) {
    let pos = -1
    for (const k of keys) pos = Math.max(pos, f.lastIndexOf(k))
    if (pos > bestPos) {
      bestPos = pos
      best = kind
    }
  }
  if (best === null) return null
  return { kind: best, normalKind: f.includes('_dx') ? 'dx' : 'gl' }
}

const pretty = (id: string): string =>
  id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()

// Group id: folder name minus a trailing version number (bricks_wall_01 →
// bricks_wall, bricks-wall-06 → bricks_wall, Wood_03 → wood). Drives the studio's
// category grouping. Falls back to the full (normalized) name when there's no suffix.
const categoryOf = (id: string): string => {
  const norm = id.toLowerCase().replace(/-/g, '_')
  return norm.replace(/_?\d+$/, '') || norm
}

const folders = fs
  .readdirSync(PBR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

const warnings: string[] = []
let written = 0

for (const id of folders) {
  const dir = path.join(PBR, id)
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f))
  const maps: Record<MapKind, string | null> = {
    color: null,
    normal: null,
    roughness: null,
    height: null,
    ao: null,
    metallic: null,
    emissive: null,
  }
  let normalPref: 'gl' | 'dx' | null = null

  for (const f of files) {
    const c = classify(f)
    if (!c) {
      warnings.push(`${id}: unclassified file "${f}" (skipped)`)
      continue
    }
    const rel = `PBR/${id}/${f}`
    if (c.kind === 'normal') {
      // prefer the GL-convention normal (what materials.ts binds); only let a GL
      // file replace a previously-picked DX one.
      if (maps.normal === null || (normalPref === 'dx' && c.normalKind === 'gl')) {
        maps.normal = rel
        normalPref = c.normalKind
      }
    } else if (maps[c.kind] === null) {
      maps[c.kind] = rel
    }
  }

  if (!maps.color) warnings.push(`${id}: no color/albedo map found → renders magenta until fixed`)

  const doc = { format: 1, id, name: pretty(id), category: categoryOf(id), maps, tuning: { ...DEFAULT_TUNING } }
  if (!DRY) fs.writeFileSync(path.join(OUT, `${id}.json`), stringifyPretty(doc))
  written++
}

console.log(`${DRY ? '[dry] ' : ''}${written} material file(s) from ${folders.length} PBR folder(s)`)
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings) console.log('  - ' + w)
}
