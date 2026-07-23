/*
 Bake a raw PBR folder into an inventory material entry: classify the source maps, encode
 each to KTX2 (UASTC + zstd supercompression, full mip chain, Y-flip baked), write them under
 canonical names beside a schema-shaped doc.

   npx tsx inventory/scripts/bake-material.ts <pbr-dir> [out-dir]

 [out-dir] defaults to inventory/items/materials/<snake_case(basename)>/. Re-baking an
 existing entry preserves the doc's hand-tuned `tuning`.

 Self-sufficient on purpose: no imports from src/ or the old scripts. The encoder is the
 official basis_universal wasm vendored in ./basis (v2_10_final_snapshot), saved as .cjs —
 the project is "type":"module" and a .js copy would load as ESM, stripping module.exports.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { parseMaterialDeclaration } from '../schemas/material.schema'

const OUT_ROOT = fileURLToPath(new URL('../items/materials/', import.meta.url))
const require = createRequire(import.meta.url)

/*
 The green channel of every normal map is NEGATED at encode. Level geometry carries no
 tangent attributes, so three shades these maps through derivative tangents — and under that
 path the pre-flipped (setYFlip) ktx2 normals lit surfaces upside-down until the editor
 compensated with normalScale.set(s, -s). Baking the negation makes the FILE correct and
 keeps runtime sign hacks out of every loader. Flip this off if that ever changes.
*/
const NEGATE_NORMAL_GREEN = true

// ───────────────────────────────────────────────────────────────── classification

type MapKind = 'color' | 'normal' | 'roughness' | 'ao' | 'metallic'

const KINDS: MapKind[] = ['color', 'normal', 'roughness', 'ao', 'metallic']
const SRGB: Record<MapKind, boolean> = { color: true, normal: false, roughness: false, ao: false, metallic: false }

// filename-token classifier, tolerant of the pack's spelling drift (ambient_occulsion,
// amibent_occlusion, baseColo, plain "base", hyphens…). Height/displacement is deliberately
// not a kind. Color is checked LAST with the greediest pattern, so it can be loose without
// stealing files from the specific kinds.
function classify(file: string): MapKind | null {
  const s = path.parse(file).name.toLowerCase().replace(/[-\s]+/g, '_')
  if (/height|displacement|bump/.test(s)) return null
  if (/normal/.test(s)) return 'normal'
  if (/rough/.test(s)) return 'roughness'
  if (/ambient|amibent|occlusion|occulsion|(^|_)ao($|_)/.test(s)) return 'ao'
  if (/metal/.test(s)) return 'metallic'
  if (/base|colo|albedo|diffuse/.test(s)) return 'color'
  return null
}

const isDx = (file: string) => /(^|_)dx($|_)/.test(path.parse(file).name.toLowerCase().replace(/[-\s]+/g, '_'))

// one source file per kind: a GL normal beats the DX variant (inverted green convention),
// png beats jpg
function pickSources(dir: string, warn: (m: string) => void): Map<MapKind, string> {
  const picked = new Map<MapKind, { file: string; score: number }>()
  for (const file of fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort()) {
    const kind = classify(file)
    if (!kind) continue
    const score = (isDx(file) ? 0 : 2) + (/\.png$/i.test(file) ? 1 : 0)
    const current = picked.get(kind)
    if (!current || score > current.score) picked.set(kind, { file, score })
  }
  const sources = new Map<MapKind, string>()
  for (const kind of KINDS) {
    const winner = picked.get(kind)
    if (!winner) continue
    if (kind === 'normal' && isDx(winner.file)) warn(`only a DX normal found (${winner.file}) — green convention may be off`)
    sources.set(kind, winner.file)
  }
  return sources
}

// ───────────────────────────────────────────────────────────────── ktx2 encoding

let basisPending: Promise<any> | null = null
const getBasis = () =>
  (basisPending ??= require('./basis/basis_encoder.cjs')().then((m: any) => {
    m.initializeBasis()
    return m
  }))

async function encodeKtx2(file: string, srgb: boolean, negateGreen: boolean): Promise<Uint8Array> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (negateGreen) for (let i = 1; i < data.length; i += 4) data[i] = 255 - data[i]

  const basis = await getBasis()
  const encoder = new basis.BasisEncoder()
  encoder.setCreateKTX2File(true)
  encoder.setKTX2UASTCSupercompression(true) // zstd
  encoder.setSliceSourceImage(0, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, false)
  encoder.setUASTC(true)
  encoder.setMipGen(true)
  // compressed uploads can't flipY at runtime, and three's PNG path flips — bake the flip or
  // every map samples upside-down
  encoder.setYFlip(true)
  encoder.setPerceptual(srgb)
  encoder.setMipSRGB(srgb)
  // v2.10 renamed the sRGB transfer call (was setKTX2SRGBTransferFunc)
  encoder.setKTX2AndBasisSRGBTransferFunc(srgb)

  const dst = new Uint8Array(info.width * info.height * 8 + (1 << 20))
  const size = encoder.encode(dst)
  encoder.delete()
  if (!size) throw new Error(`basis encode failed: ${file}`)
  return dst.slice(0, size)
}

// ───────────────────────────────────────────────────────────────── bake

async function main() {
  const [dir, outArg] = process.argv.slice(2)
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error('usage: npx tsx inventory/scripts/bake-material.ts <pbr-dir> [out-dir]')
    process.exit(1)
  }

  const id = path.basename(dir).toLowerCase().replace(/[-\s]+/g, '_')
  const outDir = outArg ?? path.join(OUT_ROOT, id)
  const warn = (m: string) => console.warn(`! ${id}: ${m}`)

  const sources = pickSources(dir, warn)
  if (!sources.has('color')) throw new Error(`${dir}: no color map among the sources`)

  fs.mkdirSync(outDir, { recursive: true })
  const maps: Partial<Record<MapKind, string>> = {}
  for (const [kind, file] of sources) {
    const encoded = await encodeKtx2(path.join(dir, file), SRGB[kind], kind === 'normal' && NEGATE_NORMAL_GREEN)
    const outName = `${kind}.ktx2`
    fs.writeFileSync(path.join(outDir, outName), encoded)
    maps[kind] = outName
    console.log(`${id}: ${outName.padEnd(14)} <- ${file} (${(encoded.length / 1024).toFixed(0)} KB)`)
  }

  // re-bake keeps hand tuning: schema-legal tuning scalars carry over from the existing doc
  const docPath = path.join(outDir, `${id}.json`)
  let tuning: Record<string, number> | undefined
  const existing = fs.statSync(docPath, { throwIfNoEntry: false })
    ? JSON.parse(fs.readFileSync(docPath, 'utf8'))
    : null
  if (existing?.tuning) {
    const kept = Object.fromEntries(
      Object.entries(existing.tuning).filter(
        ([key, value]) => ['roughness', 'metalness', 'normalScale', 'aoIntensity'].includes(key) && typeof value === 'number',
      ),
    ) as Record<string, number>
    if (Object.keys(kept).length) tuning = kept
  }

  const doc = { id, maps, ...(tuning ? { tuning } : {}) }
  parseMaterialDeclaration(id, doc) // never write a doc the schema would reject
  fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + '\n')
  console.log(`${id}: ${path.relative(process.cwd(), docPath)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
