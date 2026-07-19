/*
 Low-level GLB container surgery, shared by the offline model scripts (scripts/bake-anims.ts,
 scripts/import-model.ts). Node-only: reads and writes the raw chunks.

 Everything here edits the container IN PLACE rather than round-tripping through three's
 GLTFExporter. Exporting would re-encode embedded textures through a canvas (which does not
 exist headless), can drop material extensions, and silently loses clip.userData —
 GLTFExporter.processAnimation never writes extras. Injection preserves the source asset.
*/
import * as fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const FLOAT = 5126

export interface Glb {
  // the glTF JSON chunk. Deliberately untyped: these scripts touch a handful of fields and a
  // full glTF type surface would be noise.
  json: any
  bin: Buffer
}

export const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

// three strips these characters from node names on load, so anything that has to match a
// runtime name (dismember part keys, emissive keys) must be sanitized the same way.
export const sanitizeName = (name: string): string => THREE.PropertyBinding.sanitizeNodeName(name)

export function readGlb(file: string): Glb {
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
    else if (type === CHUNK_BIN) bin = Buffer.from(body)
    offset += 8 + length
  }
  if (!json) throw new Error(`${file} has no JSON chunk`)
  return { json, bin }
}

export function toGlbBuffer(glb: Glb): Buffer {
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

  return Buffer.concat([
    header,
    chunkHeader(jsonChunk.length, CHUNK_JSON),
    jsonChunk,
    chunkHeader(binChunk.length, CHUNK_BIN),
    binChunk,
  ])
}

export const writeGlb = (file: string, glb: Glb): void => fs.writeFileSync(file, toGlbBuffer(glb))

/*
 Parse the model headless for its skeleton, meshes and clips.

 GLTFLoader needs the geometry, not the pixels — and headless there is no canvas to decode a
 PNG into. Stripping images/textures/materials yields the identical node hierarchy, skin, bind
 poses and animation data while skipping every image decode. Done on a deep copy, so the
 caller's container is untouched.
*/
export function parseHeadless(
  glb: Glb,
  dir: string,
): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const json = JSON.parse(JSON.stringify(glb.json))
  delete json.images
  delete json.textures
  delete json.samplers
  delete json.materials
  delete json.extensionsUsed
  delete json.extensionsRequired
  for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) delete prim.material

  const data = toArrayBuffer(toGlbBuffer({ json, bin: glb.bin }))
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(data, dir, (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }), reject)
  })
}

/*
 A clip is "static" when every one of its tracks holds the same value at every key — a frozen
 pose an exporter emitted as a 2-frame animation, not something anyone authored.

 Detected by VALUE, never by name or duration: a junk clip can be called anything, and a
 genuinely short authored clip must not be swallowed. Renaming such a clip (as the older
 importer did) is worse than dropping it — it launders a frozen pose into a legitimate-looking
 playable state that silently freezes the character.
*/
export function findStaticClips(animations: THREE.AnimationClip[]): number[] {
  const isStatic = (clip: THREE.AnimationClip) => {
    if (!clip.tracks.length) return true
    return clip.tracks.every((track) => {
      const values = track.values
      const stride = values.length / track.times.length
      for (let component = 0; component < stride; component++) {
        let min = Infinity
        let max = -Infinity
        for (let i = component; i < values.length; i += stride) {
          if (values[i] < min) min = values[i]
          if (values[i] > max) max = values[i]
        }
        if (max - min !== 0) return false
      }
      return true
    })
  }

  // INDICES, not names: glTF animation names are optional and not required to be unique, so
  // dropping by name both misses unnamed clips (GLTFLoader synthesises "animation_N" for them,
  // which matches nothing in the JSON) and over-deletes when two clips share a name.
  // GLTFLoader builds its animations array in json.animations order, so the index carries over.
  const indices: number[] = []
  animations.forEach((clip, i) => {
    if (isStatic(clip)) indices.push(i)
  })
  return indices
}

// Remove animations by INDEX. Their accessors/bufferViews are left orphaned; pruneOrphans()
// reclaims them.
export function dropAnimations(glb: Glb, indices: Set<number>): number {
  const before = glb.json.animations?.length ?? 0
  if (!before) return 0
  glb.json.animations = glb.json.animations.filter((_: any, i: number) => !indices.has(i))
  return before - glb.json.animations.length
}

interface Appender {
  chunks: Buffer[]
  length: number
}

/*
 Delete accessors and bufferViews nothing references any more — the debris left behind by
 dropAnimations. Both are referenced BY INDEX from many places, so compaction means rebuilding
 each array and rewriting every reference through an old->new map.

 Bails out when an unrecognised extension is present: extensions may hold bufferView/accessor
 indices this walk does not know about, and silently renumbering those would corrupt the file.
*/
const KNOWN_EXTENSIONS = new Set(['KHR_materials_specular', 'KHR_materials_ior', 'KHR_materials_emissive_strength'])

export function pruneOrphans(glb: Glb): { accessors: number; bufferViews: number } {
  const json = glb.json
  const unknown = (json.extensionsUsed ?? []).filter((e: string) => !KNOWN_EXTENSIONS.has(e))
  if (unknown.length) return { accessors: 0, bufferViews: 0 }

  const usedAccessors = new Set<number>()
  const use = (i: unknown) => {
    if (typeof i === 'number') usedAccessors.add(i)
  }

  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const key in prim.attributes ?? {}) use(prim.attributes[key])
      use(prim.indices)
      for (const target of prim.targets ?? []) for (const key in target) use(target[key])
    }
  }
  for (const skin of json.skins ?? []) use(skin.inverseBindMatrices)
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers ?? []) {
      use(sampler.input)
      use(sampler.output)
    }
  }

  const usedViews = new Set<number>()
  for (const i of usedAccessors) {
    const view = json.accessors?.[i]?.bufferView
    if (typeof view === 'number') usedViews.add(view)
  }
  for (const image of json.images ?? []) if (typeof image.bufferView === 'number') usedViews.add(image.bufferView)

  const beforeAccessors = json.accessors?.length ?? 0
  const beforeViews = json.bufferViews?.length ?? 0
  if (usedAccessors.size === beforeAccessors && usedViews.size === beforeViews) {
    return { accessors: 0, bufferViews: 0 }
  }

  const viewMap = new Map<number, number>()
  const keptViews: any[] = []
  ;(json.bufferViews ?? []).forEach((view: any, i: number) => {
    if (!usedViews.has(i)) return
    viewMap.set(i, keptViews.length)
    keptViews.push(view)
  })

  const accessorMap = new Map<number, number>()
  const keptAccessors: any[] = []
  ;(json.accessors ?? []).forEach((accessor: any, i: number) => {
    if (!usedAccessors.has(i)) return
    accessorMap.set(i, keptAccessors.length)
    if (typeof accessor.bufferView === 'number') accessor.bufferView = viewMap.get(accessor.bufferView)
    keptAccessors.push(accessor)
  })

  const remap = (i: unknown) => (typeof i === 'number' ? accessorMap.get(i) : i)
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const key in prim.attributes ?? {}) prim.attributes[key] = remap(prim.attributes[key])
      if (typeof prim.indices === 'number') prim.indices = remap(prim.indices)
      for (const target of prim.targets ?? []) for (const key in target) target[key] = remap(target[key])
    }
  }
  for (const skin of json.skins ?? [])
    if (typeof skin.inverseBindMatrices === 'number') skin.inverseBindMatrices = remap(skin.inverseBindMatrices)
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers ?? []) {
      sampler.input = remap(sampler.input)
      sampler.output = remap(sampler.output)
    }
  }
  for (const image of json.images ?? [])
    if (typeof image.bufferView === 'number') image.bufferView = viewMap.get(image.bufferView)

  json.accessors = keptAccessors
  json.bufferViews = keptViews
  rebuildBin(glb, new Map()) // re-lay-out what survived, dropping the freed bytes

  return { accessors: beforeAccessors - keptAccessors.length, bufferViews: beforeViews - keptViews.length }
}

function pushAccessor(json: any, out: Appender, values: ArrayLike<number>, type: 'SCALAR' | 'VEC3' | 'VEC4'): number {
  const components = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4
  const data = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i++) data.writeFloatLE(values[i], i * 4)

  const byteOffset = out.length
  out.chunks.push(data)
  out.length += data.length

  json.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length })
  const accessor: any = {
    bufferView: json.bufferViews.length - 1,
    componentType: FLOAT,
    count: values.length / components,
    type,
  }

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

// three strips ':' from node names on load, so a track targeting "mixamorigHips" has to be
// matched back to the glTF node literally named "mixamorig:Hips".
function buildNodeIndex(json: any, warn: (m: string) => void): Map<string, number> {
  const byName = new Map<string, number>()
  const joints = new Set<number>((json.skins ?? []).flatMap((s: any) => s.joints ?? []))
  ;(json.nodes ?? []).forEach((node: any, i: number) => {
    if (typeof node.name !== 'string') return
    const sanitized = sanitizeName(node.name)
    const existing = byName.get(sanitized)
    if (existing === undefined) return void byName.set(sanitized, i)

    // glTF does not require unique node names, and sanitizing collapses more of them together
    // ("Hand.L" and "HandL" both become "HandL"). AnimationsDriver channels target ONE node, so a
    // collision means some tracks would drive the wrong object. Prefer the skin joint — a bone
    // track is what we are placing — and say so rather than silently taking whichever came first.
    const preferNew = joints.has(i) && !joints.has(existing)
    if (preferNew) byName.set(sanitized, i)
    warn(
      `node name "${sanitized}" is ambiguous (nodes ${existing} and ${i}); bound to node ${preferNew ? i : existing}`,
    )
  })
  return byName
}

function interpolationOf(track: THREE.KeyframeTrack, warn: (m: string) => void): 'LINEAR' | 'STEP' {
  const mode = (track as unknown as { getInterpolation(): number }).getInterpolation()
  if (mode === THREE.InterpolateDiscrete) return 'STEP'
  if (mode !== THREE.InterpolateLinear) {
    // three's smooth interpolation is not glTF CUBICSPLINE (different value layout), and
    // Mixamo clips are linear anyway — degrade loudly rather than write wrong data
    warn(`${track.name}: non-linear interpolation degraded to LINEAR`)
  }
  return 'LINEAR'
}

export interface InjectStats {
  tracks: number
  skipped: number
  warnings: string[]
  // the clips that ACTUALLY landed in the container. A clip whose every track failed node
  // lookup is not written, so callers must build their state/locomotion lists from this rather
  // than from what they asked for — otherwise the entity doc names clips the GLB does not have.
  written: string[]
}

// Append clips to the container as real glTF animations.
export function injectClips(glb: Glb, clips: THREE.AnimationClip[]): InjectStats {
  const json = glb.json
  json.accessors ??= []
  json.bufferViews ??= []
  json.animations ??= []
  json.buffers ??= [{ byteLength: glb.bin.length }]

  const warnings: string[] = []
  const warn = (m: string) => warnings.push(m)
  const nodeIndex = buildNodeIndex(json, warn)
  const out: Appender = { chunks: [], length: glb.bin.length }
  let tracks = 0
  let skipped = 0

  /*
   Every sampler in a clip usually shares one time array — 35 tracks writing 35 identical
   SCALAR accessors was 19 KB of duplicate keys on a single bruno clip. Reuse by content.
  */
  const timeAccessors = new Map<string, number>()
  const sharedTimes = (times: ArrayLike<number>) => {
    const key = times.length + ':' + Array.prototype.join.call(times, ',')
    const existing = timeAccessors.get(key)
    if (existing !== undefined) return existing
    const created = pushAccessor(json, out, times, 'SCALAR')
    timeAccessors.set(key, created)
    return created
  }

  const written: string[] = []

  for (const clip of clips) {
    const channels: any[] = []
    const samplers: any[] = []

    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.')
      const boneName = track.name.slice(0, dot)
      const property = track.name.slice(dot + 1)

      const node = nodeIndex.get(boneName)
      if (node === undefined) {
        warn(`${clip.name}: no glTF node for "${boneName}" — track dropped`)
        skipped++
        continue
      }

      const gltfPath = property === 'quaternion' ? 'rotation' : property === 'position' ? 'translation' : null
      if (!gltfPath) {
        skipped++
        continue
      }

      const input = sharedTimes(track.times)
      const output = pushAccessor(json, out, track.values, gltfPath === 'rotation' ? 'VEC4' : 'VEC3')
      samplers.push({ input, output, interpolation: interpolationOf(track, warn) })
      channels.push({ sampler: samplers.length - 1, target: { node, path: gltfPath } })
      tracks++
    }

    if (!channels.length) {
      warn(`${clip.name}: no usable tracks, animation not written`)
      continue
    }

    json.animations.push({ name: clip.name, channels, samplers })
    written.push(clip.name)
  }

  glb.bin = Buffer.concat([glb.bin, ...out.chunks])
  json.buffers[0].byteLength = glb.bin.length
  delete json.buffers[0].uri // stays a self-contained GLB

  return { tracks, skipped, warnings, written }
}

/*
 Re-lay-out the binary chunk from a map of replaced bufferView payloads, compacting away any
 orphaned bytes on the way. Views are re-emitted in their original order at fresh 4-byte
 aligned offsets, and each view object is MUTATED rather than rebuilt so byteStride and every
 accessor's index-based reference stay valid.
*/
export function rebuildBin(glb: Glb, replaced: Map<number, Buffer>): void {
  const views = (glb.json.bufferViews ?? []).map((bv: any, idx: number) => ({
    bv,
    data: replaced.get(idx) ?? glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength),
  }))
  views.sort((a: any, b: any) => (a.bv.byteOffset ?? 0) - (b.bv.byteOffset ?? 0))

  const parts: Buffer[] = []
  let offset = 0
  for (const view of views) {
    const pad = (4 - (offset % 4)) % 4
    if (pad) {
      parts.push(Buffer.alloc(pad))
      offset += pad
    }
    view.bv.byteOffset = offset
    view.bv.byteLength = view.data.length
    parts.push(view.data)
    offset += view.data.length
  }

  glb.bin = Buffer.concat(parts)
  glb.json.buffers[0].byteLength = glb.bin.length
}
