/*
 Bake an environment map into an inventory hdri item: ONE equirect KTX2 (UASTC HDR — BC6H
 class on the GPU, ~8bpp), zstd-supercompressed, mipped. The doc beside it: { id, file }.

   npx tsx inventory/scripts/bake-hdri.ts <source-image> [out-dir] [--size 1024|2048|4096]

 Sources: .exr / .hdr are decoded headless via three's loaders and resized in float;
 .png/.jpg go through sharp and the encoder's own LDR→HDR upconversion (sRGB→linear at a
 1.0 nit multiplier — LDR white lands at linear 1.0, three's SDR convention). [out-dir]
 defaults to inventory/items/hdri/<id>/; id = the pared source stem (lowercase snake,
 resolution/_hdri tokens stripped: "sky_linekotsi_18_HDRI" → "sky_linekotsi_18").

 ORIENTATION: the catalog stores equirects BOTTOM-UP (zenith in the last rows) — three's
 equirectUv puts +Y at v=1 and KTX2Loader serves rows as stored. EXRLoader already emits
 bottom-up; HDRLoader and sharp emit top-down and are flipped here at decode (measured, not
 assumed: extracted sun vectors pointed DOWN for every top-down-decoded sky before the
 flip). The proof stays in the docs — extract-sun.ts writes each sky's sun vector, and suns
 point UP; a negative-y sun after a rebake means some decoder changed its row order.

 Self-sufficient on purpose: no imports from src/ or the old scripts. The vendored basis wasm
 in ./basis (v2_10) carries the full HDR API — embind method names live in the WASM, not the
 .cjs, so grepping the js proves nothing; introspect at runtime.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { FloatType } from 'three'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'

import { parseHdriDeclaration } from '../schemas/hdri.schema'

const OUT_ROOT = fileURLToPath(new URL('../items/hdri/', import.meta.url))
const require = createRequire(import.meta.url)

const SIZES = [1024, 2048, 4096]

// hdr_image_type in the embind wrappers: 0 half, 1 float, 2 png, 3 exr, 4 hdr, 5 jpg
const HDR_IMAGE_TYPE_FLOAT = 1
const HDR_IMAGE_TYPE_PNG = 2

/*
 ASTC HDR can't represent components above ~65216; the encoder would otherwise rescale the
 whole image and stash the compensation in an "HDRScale" KTX2 key-value that three's
 KTX2Loader never reads — the sky would come back dimmer. Clamping only flattens the very
 peak of a sun disc; for IBL that's invisible, and the file needs no side-channel.
*/
const HDR_COMPONENT_MAX = 65000

type Decoded =
  | { ldr: true; data: Buffer; width: number; height: number } // resized PNG file bytes
  | { ldr: false; data: Float32Array; width: number; height: number }

// ───────────────────────────────────────────────────────────────── decode + resize

const targetDims = (w: number, h: number, size: number) =>
  w <= size ? { width: w, height: h } : { width: size, height: Math.max(1, Math.round((size * h) / w)) }

// plain box average — fidelity is fine for a downscale this pipeline feeds to a compressor
function boxResizeFloat(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw))
      const n = (x1 - x0) * (y1 - y0)
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4
          r += src[i]
          g += src[i + 1]
          b += src[i + 2]
          a += src[i + 3]
        }
      const o = (y * dw + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return out
}

function flipRows(data: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(data.length)
  const row = width * 4
  for (let y = 0; y < height; y++) out.set(data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row)
  return out
}

async function decode(file: string, size: number): Promise<Decoded> {
  const ext = path.extname(file).toLowerCase()

  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    // the encoder ingests LDR sources as PNG bytes (cHITPNGImage) and upconverts them
    // itself — so flip to bottom-up, resize with sharp, and hand it a fresh PNG
    const meta = await sharp(file).metadata()
    const dims = targetDims(meta.width!, meta.height!, size)
    const data = await sharp(file).flip().resize({ ...dims, fit: 'fill' }).png().toBuffer()
    return { ldr: true, data, ...dims }
  }

  if (ext === '.exr' || ext === '.hdr') {
    const bytes = fs.readFileSync(file)
    const loader = ext === '.exr' ? new EXRLoader() : new HDRLoader()
    loader.setDataType(FloatType)
    const parsed: any = (loader as any).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const { width, height } = parsed
    let data: Float32Array = parsed.data
    if (data.length !== width * height * 4) throw new Error(`${file}: expected RGBA float data, got length ${data.length}`)
    const dims = targetDims(width, height, size)
    if (dims.width !== width) data = boxResizeFloat(data, width, height, dims.width, dims.height)
    if (ext === '.hdr') data = flipRows(data, dims.width, dims.height) // HDRLoader emits top-down
    for (let i = 0; i < data.length; i++) if (data[i] > HDR_COMPONENT_MAX) data[i] = HDR_COMPONENT_MAX
    return { ldr: false, data, ...dims }
  }

  throw new Error(`${file}: unsupported source format '${ext}'`)
}

// ───────────────────────────────────────────────────────────────── ktx2 encoding

let basisPending: Promise<any> | null = null
const getBasis = () =>
  (basisPending ??= require('./basis/basis_encoder.cjs')().then((m: any) => {
    m.initializeBasis()
    return m
  }))

async function encodeHdrKtx2(image: Decoded): Promise<Buffer> {
  const basis = await getBasis()
  const encoder = new basis.BasisEncoder()
  encoder.setCreateKTX2File(true)
  encoder.setKTX2UASTCSupercompression(true) // zstd
  encoder.setHDR(true) // UASTC HDR 4x4 — the profile three's KTX2Loader transcodes (BC6H)
  encoder.setMipGen(true)
  encoder.setPerceptual(false)
  encoder.setMipSRGB(false)
  encoder.setKTX2AndBasisSRGBTransferFunc(false) // linear transfer — HDR radiance data

  if (image.ldr) {
    // painted LDR skies become absolute-light HDR: sRGB→linear, white = 1.0
    encoder.setSliceSourceImageHDR(
      0,
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      0,
      0,
      HDR_IMAGE_TYPE_PNG,
      true,
      1,
    )
  } else {
    encoder.setSliceSourceImageHDR(
      0,
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      image.width,
      image.height,
      HDR_IMAGE_TYPE_FLOAT,
      false,
      1,
    )
  }

  const dst = new Uint8Array(image.width * image.height * 8 + (1 << 22))
  const written = encoder.encode(dst)
  encoder.delete()
  if (!written) throw new Error('basis HDR encode failed')
  return Buffer.from(dst.slice(0, written))
}

// ───────────────────────────────────────────────────────────────── bake

async function main() {
  const argv = process.argv.slice(2)
  const sizeAt = argv.indexOf('--size')
  const size = sizeAt >= 0 ? Number(argv.splice(sizeAt, 2)[1]) : 2048
  const [source, outArg] = argv
  if (!source || !fs.statSync(source, { throwIfNoEntry: false })?.isFile() || !SIZES.includes(size)) {
    console.error('usage: npx tsx inventory/scripts/bake-hdri.ts <source-image> [out-dir] [--size 1024|2048|4096]')
    process.exit(1)
  }

  const id = path
    .parse(source)
    .name.toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/_(\d+k|hdri)(?=_|$)/g, '')
  const outDir = outArg ?? path.join(OUT_ROOT, id)

  const image = await decode(source, size)
  const ktx2 = await encodeHdrKtx2(image)

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `${id}.ktx2`), ktx2)

  const doc = { id, file: `${id}.ktx2` }
  parseHdriDeclaration(id, doc) // never write a doc the schema would reject
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(doc, null, 2) + '\n')

  console.log(
    `${id}: ${path.join(path.relative(process.cwd(), outDir), `${id}.ktx2`)} (${(ktx2.length / 1024 / 1024).toFixed(2)} MB, ${image.width}x${image.height}, ${image.ldr ? 'ldr-upconverted' : 'hdr'})`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
