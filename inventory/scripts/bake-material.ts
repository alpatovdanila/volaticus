/*
 Bake a raw PBR folder into ONE inventory material GLB: classify the source maps, resize,
 encode to KTX2 (UASTC + zstd, mips, Y-flip baked), pack AO/roughness/metallic into a single
 ORM image (glTF-native: occlusion samples R, metallicRoughness samples G/B), embed via
 KHR_texture_basisu, and carry the tuning as real glTF material factors. The doc beside it
 is a pointer: { id, file }.

   npx tsx inventory/scripts/bake-material.ts <pbr-dir> [out-dir] [--size 1024|512|256]

 --size defaults to 512. [out-dir] defaults to inventory/items/materials/<snake_case(basename)>/.
 Re-baking preserves hand tuning: factors are read back from the existing GLB (or, during the
 flat-doc migration, from the doc's legacy `tuning` block, which wins).

 The GLB carries a unit-quad carrier mesh so loaders instantiate the material and viewers
 preview it. Its UVs are authored V-up (three convention) to match the pre-flipped textures —
 upright in external viewers AND on three-generated level geometry.

 Self-sufficient on purpose: no imports from src/ or the old scripts (container code is
 deliberately duplicated with bake-gltf). The encoder is the official basis_universal wasm
 vendored in ./basis (v2_10_final_snapshot), saved as .cjs — the project is "type":"module"
 and a .js copy would load as ESM, stripping module.exports.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { parseMaterialDeclaration } from '../schemas/material.schema'

const OUT_ROOT = fileURLToPath(new URL('../items/materials/', import.meta.url))
const require = createRequire(import.meta.url)

const SIZES = [1024, 512, 256]

/*
 The green channel of every normal map is NEGATED at encode. Level geometry carries no
 tangent attributes, so three shades these maps through derivative tangents — and under that
 path the pre-flipped (setYFlip) ktx2 normals lit surfaces upside-down until the editor
 compensated with normalScale.set(s, -s). Baking the negation makes the FILE correct and
 keeps runtime sign hacks out of every loader. Flip this off if that ever changes.
*/
const NEGATE_NORMAL_GREEN = true

const DEFAULTS = { roughness: 1, metalness: 0, normalScale: 1, aoIntensity: 1 }
type Tuning = typeof DEFAULTS

// ───────────────────────────────────────────────────────────────── GLB container

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

function readGlbJson(file: string): any {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file} is not a GLB`)
  let offset = 12
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset)
    const type = buf.readUInt32LE(offset + 4)
    if (type === CHUNK_JSON) return JSON.parse(buf.subarray(offset + 8, offset + 8 + length).toString('utf8'))
    offset += 8 + length
  }
  throw new Error(`${file} has no JSON chunk`)
}

function writeGlb(file: string, json: any, bin: Buffer): void {
  const pad = (b: Buffer, filler: number) =>
    b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), filler)])
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20) // spaces per spec
  const binChunk = pad(bin, 0)

  const header = Buffer.alloc(12)
  header.writeUInt32LE(GLB_MAGIC, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  const chunkHeader = (length: number, type: number) => {
    const h = Buffer.alloc(8)
    h.writeUInt32LE(length, 0)
    h.writeUInt32LE(type, 4)
    return h
  }
  fs.writeFileSync(
    file,
    Buffer.concat([header, chunkHeader(jsonChunk.length, CHUNK_JSON), jsonChunk, chunkHeader(binChunk.length, CHUNK_BIN), binChunk]),
  )
}

// ───────────────────────────────────────────────────────────────── classification

type MapKind = 'color' | 'normal' | 'roughness' | 'ao' | 'metallic'

const KINDS: MapKind[] = ['color', 'normal', 'roughness', 'ao', 'metallic']

// filename-token classifier, tolerant of the pack's spelling drift (ambient_occulsion,
// amibent_occlusion, baseColo, plain "base", hyphens…). Height/displacement is deliberately
// not a kind. Color is checked LAST with the greediest pattern, so it can be loose without
// stealing files from the specific kinds. Callers pass a PARED stem — the material id rides
// at the front of every filename and can carry kind tokens itself ("metal_01_color_1k").
function classify(s: string): MapKind | null {
  if (/height|displacement|bump/.test(s)) return null
  if (/normal/.test(s)) return 'normal'
  if (/rough/.test(s)) return 'roughness'
  if (/ambient|amibent|occlusion|occulsion|(^|_)ao($|_)/.test(s)) return 'ao'
  if (/metal/.test(s)) return 'metallic'
  if (/base|colo|albedo|diffuse/.test(s)) return 'color'
  return null
}

const isDx = (s: string) => /(^|_)dx($|_)/.test(s)

// one source file per kind: a GL normal beats the DX variant (inverted green convention),
// png beats jpg
function pickSources(dir: string, warn: (m: string) => void): Map<MapKind, string> {
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort()
  const norm = (f: string) => path.parse(f).name.toLowerCase().replace(/[-\s]+/g, '_')
  const stems = files.map(norm)
  const prefix = path.basename(dir).toLowerCase().replace(/[-\s]+/g, '_')
  // the id as the FILES spell it can differ from the folder (metal_pattern_02/ holds
  // metal_pattren_02_* files) — their longest shared prefix is the fallback strip
  const shared =
    stems.length > 1
      ? stems.reduce((a, b) => {
          let i = 0
          while (i < a.length && a[i] === b[i]) i++
          return a.slice(0, i)
        })
      : ''
  const pared = (file: string) => {
    const s = norm(file)
    for (const p of [prefix, shared]) if (p && s.startsWith(p) && s.length > p.length) return s.slice(p.length)
    return s
  }
  const picked = new Map<MapKind, { file: string; score: number }>()
  for (const file of files) {
    const kind = classify(pared(file))
    if (!kind) continue
    const score = (isDx(pared(file)) ? 0 : 2) + (/\.png$/i.test(file) ? 1 : 0)
    const current = picked.get(kind)
    if (!current || score > current.score) picked.set(kind, { file, score })
  }
  const sources = new Map<MapKind, string>()
  for (const kind of KINDS) {
    const winner = picked.get(kind)
    if (!winner) continue
    if (kind === 'normal' && isDx(pared(winner.file))) warn(`only a DX normal found (${winner.file}) — green convention may be off`)
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

// decode → RGBA at exactly size×size, so every channel source lines up for the ORM pack
const readRgba = (file: string, size: number) =>
  sharp(file).resize({ width: size, height: size, fit: 'fill' }).ensureAlpha().raw().toBuffer()

const readGray = (file: string, size: number) =>
  sharp(file).resize({ width: size, height: size, fit: 'fill' }).greyscale().raw().toBuffer()

async function encodeKtx2(data: Buffer, size: number, srgb: boolean): Promise<Buffer> {
  const basis = await getBasis()
  const encoder = new basis.BasisEncoder()
  encoder.setCreateKTX2File(true)
  encoder.setKTX2UASTCSupercompression(true) // zstd
  encoder.setSliceSourceImage(0, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), size, size, false)
  encoder.setUASTC(true)
  encoder.setMipGen(true)
  // compressed uploads can't flipY at runtime, and three's PNG path flips — bake the flip or
  // every map samples upside-down on three-generated geometry
  encoder.setYFlip(true)
  encoder.setPerceptual(srgb)
  encoder.setMipSRGB(srgb)
  // v2.10 renamed the sRGB transfer call (was setKTX2SRGBTransferFunc)
  encoder.setKTX2AndBasisSRGBTransferFunc(srgb)

  const dst = new Uint8Array(size * size * 8 + (1 << 20))
  const written = encoder.encode(dst)
  encoder.delete()
  if (!written) throw new Error('basis encode failed')
  return Buffer.from(dst.slice(0, written))
}

// ───────────────────────────────────────────────────────────────── tuning carry-over

const isNum = (v: unknown): v is number => typeof v === 'number'

// factors already baked into an existing output GLB — hand tuning survives a re-bake
function factorsOf(glbPath: string): Partial<Tuning> {
  if (!fs.existsSync(glbPath)) return {}
  const material = readGlbJson(glbPath).materials?.[0]
  if (!material) return {}
  const out: Partial<Tuning> = {}
  if (isNum(material.pbrMetallicRoughness?.roughnessFactor)) out.roughness = material.pbrMetallicRoughness.roughnessFactor
  if (isNum(material.pbrMetallicRoughness?.metallicFactor)) out.metalness = material.pbrMetallicRoughness.metallicFactor
  if (isNum(material.normalTexture?.scale)) out.normalScale = material.normalTexture.scale
  if (isNum(material.occlusionTexture?.strength)) out.aoIntensity = material.occlusionTexture.strength
  return out
}

// legacy `tuning` block of a pre-GLB doc (the flat-catalog migration path) — wins over factors
function legacyTuningOf(docPath: string): Partial<Tuning> {
  if (!fs.existsSync(docPath)) return {}
  const tuning = JSON.parse(fs.readFileSync(docPath, 'utf8'))?.tuning ?? {}
  const out: Partial<Tuning> = {}
  for (const key of Object.keys(DEFAULTS) as (keyof Tuning)[]) if (isNum(tuning[key])) out[key] = tuning[key]
  return out
}

// ───────────────────────────────────────────────────────────────── bake

async function main() {
  const argv = process.argv.slice(2)
  const sizeAt = argv.indexOf('--size')
  const size = sizeAt >= 0 ? Number(argv.splice(sizeAt, 2)[1]) : 512
  const [dir, outArg] = argv
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() || !SIZES.includes(size)) {
    console.error('usage: npx tsx inventory/scripts/bake-material.ts <pbr-dir> [out-dir] [--size 1024|512|256]')
    process.exit(1)
  }

  const id = path.basename(dir).toLowerCase().replace(/[-\s]+/g, '_')
  const outDir = outArg ?? path.join(OUT_ROOT, id)
  const warn = (m: string) => console.warn(`! ${id}: ${m}`)

  const sources = pickSources(dir, warn)
  if (!sources.has('color')) throw new Error(`${dir}: no color map among the sources`)
  const src = (kind: MapKind) => path.join(dir, sources.get(kind)!)

  const glbPath = path.join(outDir, `${id}.glb`)
  const docPath = path.join(outDir, `${id}.json`)
  const tuning: Tuning = { ...DEFAULTS, ...factorsOf(glbPath), ...legacyTuningOf(docPath) }
  // glTF bounds these two to [0,1] (three allowed more)
  const clamped = (key: 'roughness' | 'aoIntensity') => {
    if (tuning[key] > 1) warn(`${key} ${tuning[key]} clamped to 1 (glTF bound)`)
    return Math.min(1, tuning[key])
  }

  // encode: color, normal, and the ORM pack (missing channels stay 255 = neutral)
  const images: { name: string; data: Buffer }[] = []
  const colorImage = images.push({ name: 'color', data: await encodeKtx2(await readRgba(src('color'), size), size, true) }) - 1

  let normalImage = -1
  if (sources.has('normal')) {
    const rgba = await readRgba(src('normal'), size)
    if (NEGATE_NORMAL_GREEN) for (let i = 1; i < rgba.length; i += 4) rgba[i] = 255 - rgba[i]
    normalImage = images.push({ name: 'normal', data: await encodeKtx2(rgba, size, false) }) - 1
  }

  const hasAo = sources.has('ao')
  const hasRoughMetal = sources.has('roughness') || sources.has('metallic')
  let ormImage = -1
  if (hasAo || hasRoughMetal) {
    const orm = Buffer.alloc(size * size * 4, 255)
    const fill = async (kind: MapKind, channel: number) => {
      if (!sources.has(kind)) return
      const gray = await readGray(src(kind), size)
      for (let i = 0; i < gray.length; i++) orm[i * 4 + channel] = gray[i]
    }
    await fill('ao', 0)
    await fill('roughness', 1)
    await fill('metallic', 2)
    ormImage = images.push({ name: 'orm', data: await encodeKtx2(orm, size, false) }) - 1
  }

  // ── assemble the GLB
  const json: any = {
    asset: { version: '2.0', generator: 'volaticus bake-material' },
    extensionsUsed: ['KHR_texture_basisu'],
    extensionsRequired: ['KHR_texture_basisu'],
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
    accessors: [],
    samplers: [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }], // REPEAT, trilinear
    images: [],
    textures: [],
    materials: [],
    meshes: [],
    nodes: [{ mesh: 0, name: id }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }

  const bin: Buffer[] = []
  let binLength = 0
  const addView = (data: Buffer, target?: number): number => {
    const padding = (4 - (binLength % 4)) % 4
    if (padding) {
      bin.push(Buffer.alloc(padding))
      binLength += padding
    }
    json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.length, ...(target ? { target } : {}) })
    bin.push(data)
    binLength += data.length
    return json.bufferViews.length - 1
  }
  const addFloats = (values: number[], type: 'VEC2' | 'VEC3', minMax = false): number => {
    const data = Buffer.alloc(values.length * 4)
    values.forEach((v, i) => data.writeFloatLE(v, i * 4))
    const components = type === 'VEC2' ? 2 : 3
    const accessor: any = { bufferView: addView(data, 34962), componentType: 5126, count: values.length / components, type }
    if (minMax) {
      accessor.min = [Infinity, Infinity, Infinity]
      accessor.max = [-Infinity, -Infinity, -Infinity]
      values.forEach((v, i) => {
        accessor.min[i % 3] = Math.min(accessor.min[i % 3], v)
        accessor.max[i % 3] = Math.max(accessor.max[i % 3], v)
      })
    }
    json.accessors.push(accessor)
    return json.accessors.length - 1
  }

  const texture = (image: number): number =>
    json.textures.push({ sampler: 0, extensions: { KHR_texture_basisu: { source: image } } }) - 1

  for (const image of images) json.images.push({ name: image.name, mimeType: 'image/ktx2', bufferView: addView(image.data) })

  const material: any = {
    name: id,
    pbrMetallicRoughness: {
      baseColorTexture: { index: texture(colorImage) },
      roughnessFactor: clamped('roughness'),
      metallicFactor: tuning.metalness,
    },
  }
  if (normalImage >= 0) material.normalTexture = { index: texture(normalImage), scale: tuning.normalScale }
  if (ormImage >= 0) {
    const orm = texture(ormImage)
    if (hasRoughMetal) material.pbrMetallicRoughness.metallicRoughnessTexture = { index: orm }
    if (hasAo) material.occlusionTexture = { index: orm, strength: clamped('aoIntensity') }
  }
  json.materials.push(material)

  /*
   Carrier quad: makes GLTFLoader instantiate the material and gives viewers something to
   shade. UVs are V-up (three convention) because the textures are pre-flipped — a spec-
   convention quad would preview them upside-down.
  */
  const position = addFloats([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 'VEC3', true)
  const normal = addFloats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3')
  const uv = addFloats([0, 0, 1, 0, 1, 1, 0, 1], 'VEC2')
  const indexData = Buffer.alloc(12)
  ;[0, 1, 2, 0, 2, 3].forEach((v, i) => indexData.writeUInt16LE(v, i * 2))
  json.accessors.push({ bufferView: addView(indexData, 34963), componentType: 5123, count: 6, type: 'SCALAR' })
  json.meshes.push({
    primitives: [
      {
        attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv },
        indices: json.accessors.length - 1,
        material: 0,
      },
    ],
  })

  const binBuffer = Buffer.concat(bin)
  json.buffers[0].byteLength = binBuffer.length

  fs.mkdirSync(outDir, { recursive: true })
  writeGlb(glbPath, json, binBuffer)

  const doc = { id, file: `${id}.glb` }
  parseMaterialDeclaration(id, doc) // never write a doc the schema would reject
  fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + '\n')

  // the pre-GLB layout's loose payloads — superseded by the single file
  for (const kind of [...KINDS, 'height']) fs.rmSync(path.join(outDir, `${kind}.ktx2`), { force: true })

  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`
  for (const image of images) console.log(`${id}: ${image.name.padEnd(6)} ${kb(image.data.length)}`)
  console.log(`${id}: ${path.relative(process.cwd(), glbPath)} (${kb(binBuffer.length)}, ${size}px)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
