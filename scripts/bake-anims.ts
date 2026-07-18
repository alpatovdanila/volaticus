/*
 Bake sibling Mixamo FBX clips into a GLB, so a model is ONE file and ONE request at runtime
 instead of index.glb + N .fbx.

   npx tsx scripts/bake-anims.ts resources/models/marine2
   npx tsx scripts/bake-anims.ts resources/models/marine2 --out index.baked.glb
   npx tsx scripts/bake-anims.ts resources/models/marine2 --anims "Rifle Walk.fbx,Rifle Run.fbx"

 The clips are produced by src/inventory/fbx-anim-merge.ts — the SAME retarget the runtime
 loader used to run, so baking changes when the work happens, not what it produces.

 The GLB is edited SURGICALLY: the original JSON and BIN chunks are kept and the animation
 accessors/bufferViews are appended. Round-tripping through three's GLTFExporter instead
 would re-encode the embedded PNG textures through a canvas, can drop material extensions
 (this model uses KHR_materials_specular + KHR_materials_ior), and silently loses
 clip.userData — GLTFExporter.processAnimation never writes extras. Injection preserves
 every byte of the source asset.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { mergeFbxClips, type FbxAnimSource } from '../src/inventory/fbx-anim-merge'

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const FLOAT = 5126

interface Glb {
  json: any
  bin: Buffer
}

const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

function readGlb(file: string): Glb {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file} is not a GLB`)

  let offset = 12
  let json: any = null
  let bin = Buffer.alloc(0)
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset)
    const type = buf.readUInt32LE(offset + 4)
    const body = buf.subarray(offset + 8, offset + 8 + length)
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'))
    else if (type === CHUNK_BIN) bin = body
    offset += 8 + length
  }
  if (!json) throw new Error(`${file} has no JSON chunk`)
  return { json, bin }
}

function writeGlb(file: string, glb: Glb): void {
  const pad = (b: Buffer, filler: number) =>
    b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), filler)])

  const jsonChunk = pad(Buffer.from(JSON.stringify(glb.json), 'utf8'), 0x20) // spaces per spec
  const binChunk = pad(glb.bin, 0)

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
    Buffer.concat([
      header,
      chunkHeader(jsonChunk.length, CHUNK_JSON),
      jsonChunk,
      chunkHeader(binChunk.length, CHUNK_BIN),
      binChunk,
    ]),
  )
}

/*
 GLTFLoader needs the skeleton, not the pixels — and headless there is no canvas to decode a
 PNG into. Stripping images/textures/materials yields the exact same node hierarchy, skin and
 bind poses (which is all the retarget reads) while skipping every image decode.
*/
function parseSkeleton(glb: Glb, dir: string): Promise<THREE.Object3D> {
  const json = JSON.parse(JSON.stringify(glb.json))
  delete json.images
  delete json.textures
  delete json.samplers
  delete json.materials
  delete json.extensionsUsed
  delete json.extensionsRequired
  for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) delete prim.material

  return new Promise((resolve, reject) => {
    const scratch = path.join(dir, '.__skeleton.glb')
    writeGlb(scratch, { json, bin: glb.bin })
    const data = toArrayBuffer(fs.readFileSync(scratch))
    fs.unlinkSync(scratch)
    new GLTFLoader().parse(data, dir, (gltf) => resolve(gltf.scene), reject)
  })
}

// three strips ':' from node names on load, so a track targeting "mixamorigHips" has to be
// matched back to the glTF node literally named "mixamorig:Hips".
function buildNodeIndex(json: any): Map<string, number> {
  const byName = new Map<string, number>()
  ;(json.nodes ?? []).forEach((node: any, i: number) => {
    if (typeof node.name !== 'string') return
    const sanitized = THREE.PropertyBinding.sanitizeNodeName(node.name)
    if (!byName.has(sanitized)) byName.set(sanitized, i)
  })
  return byName
}

interface Appender {
  chunks: Buffer[]
  length: number
}

// Append a float array as a bufferView + accessor, returning the accessor index.
function pushAccessor(json: any, out: Appender, values: ArrayLike<number>, type: 'SCALAR' | 'VEC3' | 'VEC4'): number {
  const components = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4
  const data = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i++) data.writeFloatLE(values[i], i * 4)

  const byteOffset = out.length
  out.chunks.push(data)
  out.length += data.length

  json.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length })
  const bufferView = json.bufferViews.length - 1

  const count = values.length / components
  const accessor: any = { bufferView, componentType: FLOAT, count, type }

  // the spec REQUIRES min/max on an animation sampler's input accessor; harmless elsewhere
  if (type === 'SCALAR') {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i]
      if (values[i] > max) max = values[i]
    }
    accessor.min = [min]
    accessor.max = [max]
  }

  json.accessors.push(accessor)
  return json.accessors.length - 1
}

function interpolationOf(track: THREE.KeyframeTrack): 'LINEAR' | 'STEP' {
  const mode = (track as unknown as { getInterpolation(): number }).getInterpolation()
  if (mode === THREE.InterpolateDiscrete) return 'STEP'
  if (mode !== THREE.InterpolateLinear) {
    // three's smooth interpolation is not glTF CUBICSPLINE (different value layout), and
    // Mixamo clips are linear anyway — degrade loudly rather than write wrong data
    console.warn(`  ! ${track.name}: non-linear interpolation degraded to LINEAR`)
  }
  return 'LINEAR'
}

function injectClips(glb: Glb, clips: THREE.AnimationClip[]): { tracks: number; skipped: number } {
  const json = glb.json
  json.accessors ??= []
  json.bufferViews ??= []
  json.animations ??= []
  json.buffers ??= [{ byteLength: glb.bin.length }]

  const nodeIndex = buildNodeIndex(json)
  const out: Appender = { chunks: [], length: glb.bin.length }
  let tracksWritten = 0
  let skipped = 0

  for (const clip of clips) {
    const channels: any[] = []
    const samplers: any[] = []

    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.')
      const boneName = track.name.slice(0, dot)
      const property = track.name.slice(dot + 1)

      const node = nodeIndex.get(boneName)
      if (node === undefined) {
        console.warn(`  ! ${clip.name}: no glTF node for "${boneName}" — track dropped`)
        skipped++
        continue
      }

      const gltfPath = property === 'quaternion' ? 'rotation' : property === 'position' ? 'translation' : null
      if (!gltfPath) {
        skipped++
        continue
      }

      const input = pushAccessor(json, out, track.times, 'SCALAR')
      const output = pushAccessor(json, out, track.values, gltfPath === 'rotation' ? 'VEC4' : 'VEC3')

      samplers.push({ input, output, interpolation: interpolationOf(track) })
      channels.push({ sampler: samplers.length - 1, target: { node, path: gltfPath } })
      tracksWritten++
    }

    if (!channels.length) {
      console.warn(`  ! ${clip.name}: no usable tracks, animation not written`)
      continue
    }

    const animation: any = { name: clip.name, channels, samplers }
    // GLTFLoader calls assignExtrasToUserData on animations, so this comes back as
    // clip.userData.rootMotion — the same shape the runtime merge produced.
    if (clip.userData?.rootMotion) animation.extras = { rootMotion: clip.userData.rootMotion }
    json.animations.push(animation)
  }

  glb.bin = Buffer.concat([glb.bin, ...out.chunks])
  json.buffers[0].byteLength = glb.bin.length
  delete json.buffers[0].uri // stays a self-contained GLB

  return { tracks: tracksWritten, skipped }
}

async function main() {
  const argv = process.argv.slice(2)
  const positional = argv.filter((a) => !a.startsWith('--'))
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }

  const target = positional[0]
  if (!target) {
    console.error('usage: tsx scripts/bake-anims.ts <model-dir|index.glb> [--out name.glb] [--anims "a.fbx,b.fbx"]')
    process.exit(1)
  }

  const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory()
  const source = isDir ? path.join(target, 'index.glb') : target
  const dir = path.dirname(source)
  if (!fs.existsSync(source)) throw new Error(`no GLB at ${source}`)

  const animFiles = (flag('anims')?.split(',').map((s) => s.trim()) ?? fs.readdirSync(dir).filter((f) => /\.fbx$/i.test(f))).sort()
  if (!animFiles.length) throw new Error(`no .fbx animations beside ${source}`)

  const outFile = path.join(dir, flag('out') ?? 'index.baked.glb')

  console.log(`source  ${source}`)
  console.log(`anims   ${animFiles.length} file(s)`)

  const glb = readGlb(source)
  const skeleton = await parseSkeleton(glb, dir)

  const fbxLoader = new FBXLoader()
  const sources: FbxAnimSource[] = []
  for (const file of animFiles) {
    const root = fbxLoader.parse(toArrayBuffer(fs.readFileSync(path.join(dir, file))), dir)
    sources.push({ name: file.replace(/\.fbx$/i, ''), root })
  }

  const clips = mergeFbxClips(skeleton, sources)
  console.log(`merged  ${clips.length} clip(s)`)

  const before = glb.json.animations?.length ?? 0
  const stats = injectClips(glb, clips)
  writeGlb(outFile, glb)

  const size = (n: number) => (n / 1024 / 1024).toFixed(2) + ' MB'
  console.log(`\nwrote   ${outFile}`)
  console.log(`        ${before} baked + ${clips.length} merged = ${glb.json.animations.length} animations`)
  console.log(`        ${stats.tracks} tracks${stats.skipped ? `, ${stats.skipped} skipped` : ''}`)
  console.log(`        ${size(fs.statSync(source).size)} -> ${size(fs.statSync(outFile).size)}`)
  console.log(`\nnext: point the entity's model.src at ${path.basename(outFile)} and drop model.anims`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
