/*
 Extract the dominant light direction from a baked hdri item and store it in the doc as
 { sun: [x, y, z] } — a unit vector in the frame three samples the equirect in.

   npx tsx inventory/scripts/extract-sun.ts [entry-dir ...]

 No args = every entry under inventory/items/hdri. This is bake-time analysis of the ITEM's
 own ktx2 (transcoded back to half-float by the vendored basis wasm): the game places a real
 sun straight from the doc and never reads pixels at runtime. A sky with no concentrated
 bright region (uniform painted domes, overcast) gets NO sun field — absent means "no
 distinct sun", never a made-up direction.

 Method: threshold at 90% of peak luminance, then centroid the surviving texels as direction
 VECTORS on the unit sphere, weighted by luminance × solid angle (cos elevation) — seam- and
 pole-safe where a (u,v) average is not. Directions invert three's equirectUv with rows in
 KTX2Loader order (v = (row + 0.5)/height, no flip); if FLIP_Y in bake-hdri.ts ever changes,
 rerun this — both read the same stored rows, so they stay consistent by construction.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { parseHdriDeclaration } from '../schemas/hdri.schema'

const ITEMS_ROOT = fileURLToPath(new URL('../items/hdri/', import.meta.url))
const require = createRequire(import.meta.url)

// a "sun" wider than this fraction of the sphere is not a sun — it's a bright dome
const MAX_SUN_COVERAGE = 0.15
// peak this close to the sky's median radiance = no concentrated light source at all
const MIN_PEAK_OVER_MEDIAN = 1.5

let basisPending: Promise<any> | null = null
const getBasis = () =>
  (basisPending ??= require('./basis/basis_encoder.cjs')().then((m: any) => {
    m.initializeBasis()
    return m
  }))

const halfToFloat = (h: number): number => {
  const s = (h & 0x8000) >> 15
  const e = (h & 0x7c00) >> 10
  const f = h & 0x03ff
  const v = e === 0 ? f / 1024 / 16384 : e === 31 ? 65504 : (1 + f / 1024) * 2 ** (e - 15)
  return s ? -v : v
}

// transcode the mip whose width is ≤256 — ~1.4° per texel, plenty for a sun centroid
async function decodeForAnalysis(file: string): Promise<{ lum: Float32Array; width: number; height: number }> {
  const basis = await getBasis()
  const ktx2 = new basis.KTX2File(new Uint8Array(fs.readFileSync(file)))
  if (!ktx2.isValid() || !ktx2.startTranscoding()) throw new Error(`${file}: transcode init failed`)

  const levels = ktx2.getLevels()
  let level = 0
  let width = ktx2.getWidth()
  let height = ktx2.getHeight()
  while (level + 1 < levels && width > 256) {
    level++
    width = Math.max(1, width >> 1)
    height = Math.max(1, height >> 1)
  }

  const HALF = basis.transcoder_texture_format.cTFRGBA_HALF.value
  const dst = new Uint8Array(ktx2.getImageTranscodedSizeInBytes(level, 0, 0, HALF))
  if (!ktx2.transcodeImage(dst, level, 0, 0, HALF, 0, -1, -1)) throw new Error(`${file}: transcode failed`)
  ktx2.close()
  ktx2.delete()

  const half = new Uint16Array(dst.buffer, dst.byteOffset, dst.byteLength / 2)
  const lum = new Float32Array(width * height)
  for (let i = 0; i < lum.length; i++) {
    lum[i] =
      0.2126 * halfToFloat(half[i * 4]) + 0.7152 * halfToFloat(half[i * 4 + 1]) + 0.0722 * halfToFloat(half[i * 4 + 2])
  }
  return { lum, width, height }
}

function extractSun(lum: Float32Array, width: number, height: number): { sun: [number, number, number] | null; coverage: number } {
  let peak = 0
  for (let i = 0; i < lum.length; i++) if (lum[i] > peak) peak = lum[i]
  const median = [...lum].sort((a, b) => a - b)[lum.length >> 1]
  if (peak < median * MIN_PEAK_OVER_MEDIAN) return { sun: null, coverage: 1 }

  const threshold = peak * 0.9
  let x = 0
  let y = 0
  let z = 0
  let solidAbove = 0
  let solidTotal = 0
  for (let row = 0; row < height; row++) {
    const v = (row + 0.5) / height
    const elevation = (v - 0.5) * Math.PI
    const cosEl = Math.cos(elevation)
    solidTotal += cosEl * width
    for (let col = 0; col < width; col++) {
      const value = lum[row * width + col]
      if (value < threshold) continue
      solidAbove += cosEl
      const azimuth = ((col + 0.5) / width - 0.5) * 2 * Math.PI
      const weight = value * cosEl
      x += cosEl * Math.cos(azimuth) * weight
      y += Math.sin(elevation) * weight
      z += cosEl * Math.sin(azimuth) * weight
    }
  }

  const coverage = solidAbove / solidTotal
  const length = Math.hypot(x, y, z)
  if (coverage > MAX_SUN_COVERAGE || !length) return { sun: null, coverage }
  const round = (n: number) => Math.round(n * 10000) / 10000
  return { sun: [round(x / length), round(y / length), round(z / length)], coverage }
}

async function processEntry(dir: string): Promise<void> {
  const id = path.basename(dir)
  const docPath = path.join(dir, `${id}.json`)
  const doc: Record<string, unknown> = JSON.parse(fs.readFileSync(docPath, 'utf8'))

  const { lum, width, height } = await decodeForAnalysis(path.join(dir, String(doc.file)))
  const { sun, coverage } = extractSun(lum, width, height)

  if (sun) doc.sun = sun
  else delete doc.sun
  parseHdriDeclaration(id, doc) // never write a doc the schema would reject
  fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + '\n')

  console.log(
    sun
      ? `${id}: sun [${sun.join(', ')}]`
      : `${id}: no distinct sun (bright coverage ${(coverage * 100).toFixed(1)}%)`,
  )
}

async function main() {
  const dirs = process.argv.slice(2)
  const targets = dirs.length
    ? dirs
    : fs
        .readdirSync(ITEMS_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(ITEMS_ROOT, e.name))
  for (const target of targets) await processEntry(target)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
