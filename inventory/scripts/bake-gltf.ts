/*
 Bake sibling FBX animation clips into a GLB: one components file, one request at runtime.

   npx tsx inventory/scripts/bake-gltf.ts <components-dir> [out.glb] [--maxtex <px>]

 <components-dir> holds index.glb plus any number of .fbx files — every .fbx becomes a clip named
 after its file, and any animation authored inside index.glb is DROPPED: the sibling FBX set
 is exactly what ships. [out.glb] defaults to <components-dir>/index.baked.glb.

 Besides the merge, the container is NORMALIZED so any viewer renders it the same way:
 per-vertex tangents are baked wherever a normal-mapped primitive ships none, and skinned mesh
 nodes are lifted to the scene root (see the passes below for the why of each). `--maxtex`
 additionally caps embedded texture size — opt-in, being the one lossy pass here.

 Self-sufficient on purpose: the GLB container surgery and the Mixamo retarget live here, with
 no imports from src/. The container is edited IN PLACE rather than round-tripped through
 GLTFExporter — exporting re-encodes embedded textures through a canvas (which does not exist
 headless) and can drop material extensions; everything else stays byte-identical.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import sharp from 'sharp'

// ───────────────────────────────────────────────────────────────── GLB container

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const FLOAT = 5126
const ARRAY_BUFFER = 34962

// the glTF JSON chunk stays untyped: this script touches a handful of fields and a full
// glTF type surface would be noise
interface Glb {
  json: any
  bin: Buffer
}

type Warn = (message: string) => void

const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

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
    else if (type === CHUNK_BIN) bin = Buffer.from(body)
    offset += 8 + length
  }
  if (!json) throw new Error(`${file} has no JSON chunk`)
  return { json, bin }
}

function toGlbBuffer(glb: Glb): Buffer {
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

// append-only writer for new float accessors; commit() lands the bytes in the container
function createAppender(glb: Glb) {
  const json = glb.json
  json.accessors ??= []
  json.bufferViews ??= []
  json.buffers ??= [{ byteLength: glb.bin.length }]
  const chunks: Buffer[] = []
  let length = glb.bin.length

  const pushAccessor = (values: ArrayLike<number>, type: 'SCALAR' | 'VEC3' | 'VEC4', target?: number): number => {
    const components = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4
    const data = Buffer.alloc(values.length * 4)
    for (let i = 0; i < values.length; i++) data.writeFloatLE(values[i], i * 4)

    const view: any = { buffer: 0, byteOffset: length, byteLength: data.length }
    if (target !== undefined) view.target = target
    json.bufferViews.push(view)
    chunks.push(data)
    length += data.length

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

  const commit = () => {
    glb.bin = Buffer.concat([glb.bin, ...chunks])
    json.buffers[0].byteLength = glb.bin.length
    delete json.buffers[0].uri // stays a self-contained GLB
    chunks.length = 0
  }

  return { pushAccessor, commit }
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

// flat numeric read of an accessor, interleaving-aware. Covers what the tangent pass meets in
// practice — plain float attributes and integer indices; sparse/quantized data returns null
// and the caller skips.
function readAccessor(glb: Glb, index: number): number[] | null {
  const a = glb.json.accessors?.[index]
  const components = a ? TYPE_COMPONENTS[a.type] : undefined
  const compSize = a ? COMPONENT_SIZE[a.componentType] : undefined
  if (!a || !components || !compSize || a.sparse || a.normalized) return null
  const bv = glb.json.bufferViews?.[a.bufferView]
  if (!bv) return null

  const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength)
  const stride = bv.byteStride ?? components * compSize
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const out = new Array<number>(a.count * components)
  for (let el = 0; el < a.count; el++) {
    for (let c = 0; c < components; c++) {
      const o = base + el * stride + c * compSize
      out[el * components + c] =
        a.componentType === 5126
          ? dv.getFloat32(o, true)
          : a.componentType === 5125
            ? dv.getUint32(o, true)
            : a.componentType === 5123
              ? dv.getUint16(o, true)
              : a.componentType === 5122
                ? dv.getInt16(o, true)
                : a.componentType === 5121
                  ? dv.getUint8(o)
                  : dv.getInt8(o)
    }
  }
  return out
}

// ───────────────────────────────────────────────────────────────── normalization

/*
 A node that carries a skinned mesh belongs at the scene root: the spec says its own and its
 ancestors' transforms MUST be ignored for skinned rendering, and viewers differ in honoring
 that (validator: NODE_SKINNED_MESH_NON_ROOT). Lifting the node to the root — its ignored
 transform dropped — renders identically everywhere and removes the ambiguity. A skinned node
 with children is left alone: its subtree DOES honor transforms and would move.
*/
function rootSkinnedMeshes(glb: Glb, warn: Warn): number {
  const json = glb.json
  const nodes = json.nodes ?? []

  const parentOf = new Map<number, number>()
  nodes.forEach((node: any, i: number) => (node.children ?? []).forEach((c: number) => parentOf.set(c, i)))

  const sceneOf = new Map<number, any>()
  for (const scene of json.scenes ?? []) {
    const stack = [...(scene.nodes ?? [])]
    while (stack.length) {
      const i = stack.pop()
      sceneOf.set(i, scene)
      stack.push(...(nodes[i]?.children ?? []))
    }
  }

  let lifted = 0
  nodes.forEach((node: any, i: number) => {
    if (node.mesh === undefined || node.skin === undefined) return
    const parent = parentOf.get(i)
    const scene = sceneOf.get(i)
    if (parent === undefined || !scene) return
    if (node.children?.length) return warn(`skinned mesh node ${i} has children — left non-root`)

    const siblings = nodes[parent].children.filter((c: number) => c !== i)
    if (siblings.length) nodes[parent].children = siblings
    else delete nodes[parent].children
    delete node.translation
    delete node.rotation
    delete node.scale
    delete node.matrix
    ;(scene.nodes ??= []).push(i)
    lifted++
  })
  return lifted
}

/*
 A material with a normal map requires a tangent space, and a primitive that ships none forces
 the viewer to synthesize one at load — three derives screen-space tangents, other engines run
 MikkTSpace, and the results disagree (validator: MESH_PRIMITIVE_GENERATED_TANGENT_SPACE).
 Bake per-vertex tangents for every triangle primitive that has the material's normal map plus
 POSITION/NORMAL/TEXCOORD but no TANGENT, so every viewer shades the same surface.
*/
function generateTangents(glb: Glb, warn: Warn): number {
  const json = glb.json
  const { pushAccessor, commit } = createAppender(glb)
  const cache = new Map<string, number>() // primitives sharing attribute accessors share the tangents
  let generated = 0

  for (const [mi, mesh] of (json.meshes ?? []).entries()) {
    for (const prim of mesh.primitives ?? []) {
      if ((prim.mode ?? 4) !== 4) continue // triangles only
      const normalTexture = json.materials?.[prim.material]?.normalTexture
      if (!normalTexture || !prim.attributes || prim.attributes.TANGENT !== undefined) continue

      const uvAttr = `TEXCOORD_${normalTexture.texCoord ?? 0}`
      const { POSITION, NORMAL } = prim.attributes
      const uvIndex = prim.attributes[uvAttr]
      const key = `${POSITION}|${NORMAL}|${uvIndex}|${prim.indices ?? ''}`
      const cached = cache.get(key)
      if (cached !== undefined) {
        prim.attributes.TANGENT = cached
        generated++
        continue
      }

      const pos = POSITION === undefined ? null : readAccessor(glb, POSITION)
      const nrm = NORMAL === undefined ? null : readAccessor(glb, NORMAL)
      const uv = uvIndex === undefined ? null : readAccessor(glb, uvIndex)
      const indices =
        prim.indices === undefined
          ? pos && Array.from({ length: pos.length / 3 }, (_, i) => i)
          : readAccessor(glb, prim.indices)
      if (!pos || !nrm || !uv || !indices) {
        warn(`mesh ${mesh.name ?? mi}: normal-mapped primitive with unreadable attributes — tangents skipped`)
        continue
      }

      const accessor = pushAccessor(lengyelTangents(pos, nrm, uv, indices), 'VEC4', ARRAY_BUFFER)
      cache.set(key, accessor)
      prim.attributes.TANGENT = accessor
      generated++
    }
  }

  commit()
  return generated
}

/*
 Drop accessors and bufferViews nothing references — exporter leftovers riding in the source
 (validator: UNUSED_OBJECT) and the data of the wiped authored animations — then re-pack the
 binary chunk around the survivors. Both arrays are index-referenced from many places, so
 pruning is mark → compact → rewrite every reference through an old→new map. Extensions may
 hold indices this walk does not know about; anything beyond material-level KHR extensions
 bails rather than risk corrupting the file.
*/
const SAFE_EXTENSION = /^KHR_(materials_|texture_transform)/

function pruneUnused(glb: Glb, warn: Warn): number {
  const json = glb.json
  const unknown = (json.extensionsUsed ?? []).filter((e: string) => !SAFE_EXTENSION.test(e))
  if (unknown.length) {
    warn(`unknown extensions (${unknown.join(', ')}) — unused-object prune skipped`)
    return 0
  }

  const accessors = json.accessors ?? []
  const bufferViews = json.bufferViews ?? []

  const usedAccessors = new Set<number>()
  const use = (i: unknown) => {
    if (typeof i === 'number') usedAccessors.add(i)
  }
  for (const mesh of json.meshes ?? [])
    for (const prim of mesh.primitives ?? []) {
      Object.values(prim.attributes ?? {}).forEach(use)
      use(prim.indices)
      for (const target of prim.targets ?? []) Object.values(target).forEach(use)
    }
  for (const skin of json.skins ?? []) use(skin.inverseBindMatrices)
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      use(sampler.input)
      use(sampler.output)
    }

  const usedViews = new Set<number>()
  const useView = (i: unknown) => {
    if (typeof i === 'number') usedViews.add(i)
  }
  for (const i of usedAccessors) {
    useView(accessors[i]?.bufferView)
    useView(accessors[i]?.sparse?.indices?.bufferView)
    useView(accessors[i]?.sparse?.values?.bufferView)
  }
  for (const image of json.images ?? []) useView(image.bufferView)

  const dropped = accessors.length - usedAccessors.size + (bufferViews.length - usedViews.size)
  if (!dropped) return 0

  const viewMap = new Map<number, number>()
  const keptViews: any[] = []
  bufferViews.forEach((view: any, i: number) => {
    if (!usedViews.has(i)) return
    viewMap.set(i, keptViews.length)
    keptViews.push(view)
  })
  const accessorMap = new Map<number, number>()
  const keptAccessors: any[] = []
  accessors.forEach((accessor: any, i: number) => {
    if (!usedAccessors.has(i)) return
    accessorMap.set(i, keptAccessors.length)
    keptAccessors.push(accessor)
  })

  const remapView = (i: unknown) => (typeof i === 'number' ? viewMap.get(i) : i)
  const remap = (i: unknown) => (typeof i === 'number' ? accessorMap.get(i) : i)
  for (const accessor of keptAccessors) {
    accessor.bufferView = remapView(accessor.bufferView)
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = remapView(accessor.sparse.indices.bufferView)
      accessor.sparse.values.bufferView = remapView(accessor.sparse.values.bufferView)
    }
  }
  for (const mesh of json.meshes ?? [])
    for (const prim of mesh.primitives ?? []) {
      for (const key of Object.keys(prim.attributes ?? {})) prim.attributes[key] = remap(prim.attributes[key])
      prim.indices = remap(prim.indices)
      for (const target of prim.targets ?? []) for (const key of Object.keys(target)) target[key] = remap(target[key])
    }
  for (const skin of json.skins ?? []) skin.inverseBindMatrices = remap(skin.inverseBindMatrices)
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      sampler.input = remap(sampler.input)
      sampler.output = remap(sampler.output)
    }
  for (const image of json.images ?? []) image.bufferView = remapView(image.bufferView)

  // re-pack the binary in surviving-view order; accessor byteOffsets are view-relative and
  // view contents are byte-identical, so only the view offsets change
  const parts: Buffer[] = []
  let offset = 0
  for (const view of keptViews) {
    const padding = (4 - (offset % 4)) % 4
    if (padding) {
      parts.push(Buffer.alloc(padding))
      offset += padding
    }
    parts.push(glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength))
    view.byteOffset = offset
    offset += view.byteLength
  }
  json.accessors = keptAccessors
  json.bufferViews = keptViews
  glb.bin = Buffer.concat(parts)
  json.buffers[0].byteLength = glb.bin.length

  return dropped
}

/*
 --maxtex N: cap every embedded texture's longest side at N px. Source exports ship 4K maps
 that dwarf the mesh they wrap (a 4K knight is 29MB of PNG against 2MB of geometry) and no
 character is ever read at that density in game. Decode → resize → re-encode in the image's
 own format, then rebuild the binary chunk: a view's CONTENTS change length here, so every
 later view shifts — accessor byteOffsets are view-relative and stay put, as in the prune above.
*/
async function resizeTextures(glb: Glb, limit: number): Promise<number> {
  const json = glb.json
  const replaced = new Map<number, Buffer>() // bufferView index → re-encoded bytes
  for (const image of json.images ?? []) {
    if (image.bufferView == null || replaced.has(image.bufferView)) continue
    const view = json.bufferViews[image.bufferView]
    const bytes = glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const { width = 0, height = 0 } = await sharp(bytes).metadata()
    if (Math.max(width, height) <= limit) continue

    const fit = sharp(bytes).resize({ width: limit, height: limit, fit: 'inside' })
    const encoded =
      image.mimeType === 'image/jpeg'
        ? await fit.jpeg({ quality: 90 }).toBuffer()
        : await fit.png({ compressionLevel: 9 }).toBuffer()
    replaced.set(image.bufferView, encoded)
    console.log(
      `  ${image.name ?? '?'}: ${width}×${height} → ≤${limit}px, ` +
        `${(view.byteLength / 1e6).toFixed(1)}MB → ${(encoded.length / 1e6).toFixed(1)}MB`,
    )
  }
  if (!replaced.size) return 0

  const parts: Buffer[] = []
  let offset = 0
  json.bufferViews.forEach((view: any, i: number) => {
    const data = replaced.get(i) ?? glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const padding = (4 - (offset % 4)) % 4
    if (padding) {
      parts.push(Buffer.alloc(padding))
      offset += padding
    }
    view.byteOffset = offset
    view.byteLength = data.length
    parts.push(data)
    offset += data.length
  })
  glb.bin = Buffer.concat(parts)
  json.buffers[0].byteLength = glb.bin.length

  return replaced.size
}

// Lengyel's method: accumulate each triangle's uv-space direction vectors on its vertices,
// Gram-Schmidt against the normal, and carry handedness in w (glTF: bitangent = cross(n,t)·w)
function lengyelTangents(pos: number[], nrm: number[], uv: number[], indices: number[]): number[] {
  const count = pos.length / 3
  const tan1 = new Float64Array(count * 3)
  const tan2 = new Float64Array(count * 3)

  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]
    const b = indices[t + 1]
    const c = indices[t + 2]
    const x1 = pos[b * 3] - pos[a * 3]
    const y1 = pos[b * 3 + 1] - pos[a * 3 + 1]
    const z1 = pos[b * 3 + 2] - pos[a * 3 + 2]
    const x2 = pos[c * 3] - pos[a * 3]
    const y2 = pos[c * 3 + 1] - pos[a * 3 + 1]
    const z2 = pos[c * 3 + 2] - pos[a * 3 + 2]
    const s1 = uv[b * 2] - uv[a * 2]
    const t1 = uv[b * 2 + 1] - uv[a * 2 + 1]
    const s2 = uv[c * 2] - uv[a * 2]
    const t2 = uv[c * 2 + 1] - uv[a * 2 + 1]

    const det = s1 * t2 - s2 * t1
    if (!det || !isFinite(det)) continue // uv-degenerate triangle contributes nothing
    const r = 1 / det
    const sx = (t2 * x1 - t1 * x2) * r
    const sy = (t2 * y1 - t1 * y2) * r
    const sz = (t2 * z1 - t1 * z2) * r
    const tx = (s1 * x2 - s2 * x1) * r
    const ty = (s1 * y2 - s2 * y1) * r
    const tz = (s1 * z2 - s2 * z1) * r
    for (const v of [a, b, c]) {
      tan1[v * 3] += sx
      tan1[v * 3 + 1] += sy
      tan1[v * 3 + 2] += sz
      tan2[v * 3] += tx
      tan2[v * 3 + 1] += ty
      tan2[v * 3 + 2] += tz
    }
  }

  const out = new Array<number>(count * 4)
  for (let v = 0; v < count; v++) {
    let nx = nrm[v * 3]
    let ny = nrm[v * 3 + 1]
    let nz = nrm[v * 3 + 2]
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl
    ny /= nl
    nz /= nl

    let tx = tan1[v * 3]
    let ty = tan1[v * 3 + 1]
    let tz = tan1[v * 3 + 2]
    const d = nx * tx + ny * ty + nz * tz
    tx -= nx * d
    ty -= ny * d
    tz -= nz * d
    let l = Math.hypot(tx, ty, tz)
    if (l < 1e-8) {
      // vertex touched by no valid uv triangle: any unit tangent perpendicular to n will do
      const [ax, ay, az] = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0]
      tx = ay * nz - az * ny
      ty = az * nx - ax * nz
      tz = ax * ny - ay * nx
      l = Math.hypot(tx, ty, tz) || 1
    }
    tx /= l
    ty /= l
    tz /= l

    const cx = ny * tz - nz * ty
    const cy = nz * tx - nx * tz
    const cz = nx * ty - ny * tx
    const w = cx * tan2[v * 3] + cy * tan2[v * 3 + 1] + cz * tan2[v * 3 + 2] < 0 ? -1 : 1
    out[v * 4] = tx
    out[v * 4 + 1] = ty
    out[v * 4 + 2] = tz
    out[v * 4 + 3] = w
  }
  return out
}

// ───────────────────────────────────────────────────────────────── headless parse

/*
 Parse the components headless, for its skeleton. GLTFLoader needs the geometry, not the pixels —
 and there is no canvas to decode a PNG into. Stripping images/textures/materials yields the
 identical node hierarchy, skin and bind poses while skipping every image decode. Done on a
 deep copy; the container itself is untouched.
*/
function parseHeadless(glb: Glb, dir: string): Promise<THREE.Object3D> {
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
    new GLTFLoader().parse(data, dir, (gltf) => resolve(gltf.scene), reject)
  })
}

// ───────────────────────────────────────────────────────────────── clip injection

/*
 three strips ':' (and more) from node names on load, so a merged track targeting
 "mixamorigHips" must be matched back to the glTF node literally named "mixamorig:Hips".
 glTF does not require unique names, and sanitizing collapses more of them together
 ("Hand.L" and "HandL"); a channel targets ONE node, so on a collision prefer the skin
 JOINT — a bone track is what we are placing — and say so rather than silently taking
 whichever came first.
*/
function buildNodeIndex(json: any, warn: Warn): Map<string, number> {
  const byName = new Map<string, number>()
  const joints = new Set<number>((json.skins ?? []).flatMap((s: any) => s.joints ?? []))
  ;(json.nodes ?? []).forEach((node: any, i: number) => {
    if (typeof node.name !== 'string') return
    const sanitized = THREE.PropertyBinding.sanitizeNodeName(node.name)
    const existing = byName.get(sanitized)
    if (existing === undefined) return void byName.set(sanitized, i)

    const preferNew = joints.has(i) && !joints.has(existing)
    if (preferNew) byName.set(sanitized, i)
    warn(
      `node name "${sanitized}" is ambiguous (nodes ${existing} and ${i}); bound to node ${preferNew ? i : existing}`,
    )
  })
  return byName
}

/*
 Append the clips to the container as real glTF animations. Tracks come from mergeFbxClips, so
 they are LINEAR by construction. Samplers in a clip usually share one time array — reused by
 content, otherwise 35 tracks write 35 identical SCALAR accessors.
*/
function injectClips(glb: Glb, clips: THREE.AnimationClip[], warn: Warn): void {
  const json = glb.json
  json.animations ??= []
  const { pushAccessor, commit } = createAppender(glb)
  const nodeIndex = buildNodeIndex(json, warn)

  const timeAccessors = new Map<string, number>()
  const sharedTimes = (times: ArrayLike<number>) => {
    const key = times.length + ':' + Array.prototype.join.call(times, ',')
    const existing = timeAccessors.get(key)
    if (existing !== undefined) return existing
    const created = pushAccessor(times, 'SCALAR')
    timeAccessors.set(key, created)
    return created
  }

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
        continue
      }

      const gltfPath = property === 'quaternion' ? 'rotation' : property === 'position' ? 'translation' : null
      if (!gltfPath) continue

      const input = sharedTimes(track.times)
      const output = pushAccessor(track.values, gltfPath === 'rotation' ? 'VEC4' : 'VEC3')
      samplers.push({ input, output, interpolation: 'LINEAR' })
      channels.push({ sampler: samplers.length - 1, target: { node, path: gltfPath } })
    }

    if (!channels.length) {
      warn(`${clip.name}: no usable tracks, animation not written`)
      continue
    }

    json.animations.push({ name: clip.name, channels, samplers })
  }

  commit()
}

// ───────────────────────────────────────────────────────────────── FBX clip merge

interface FbxAnimSource {
  name: string // clip name (the fbx filename without extension)
  root: THREE.Object3D // the parsed FBX root, carrying .animations
}

/*
 Merge sibling Mixamo FBX clips onto the GLB. Both come from the SAME Mixamo rig, and three's
 loaders strip the ':' from bone names on BOTH sides, so the FBX clip's bone track names
 ("mixamorigHips.quaternion") already match the GLB's Bone objects — the clip binds directly,
 with NO retargeting (retargetClip frame-samples and poses the target skeleton). Track policy:
 ROTATION tracks for every bone, plus the HIPS HEIGHT (Y) — all other position tracks carry
 FBX-unit root motion that doesn't fit the GLB's scaled armature, so the animation plays in
 place at the right size. Corrections: the HIPS gets the GLB rest premultiplied (root curves
 are identity-framed — Mixamo's pre-rotation lives on the rig node, never in the curves);
 every OTHER bone gets the per-bone rig-rest delta rest_glb·rest_fbx⁻¹ (identity when the rigs
 truly match, so same-rig models pass through untouched; auto-rigged GLBs with different bind
 poses land in the right frame).
*/
function mergeFbxClips(scene: THREE.Object3D, sources: FbxAnimSource[]): THREE.AnimationClip[] {
  // GLB bone rests — the frame the clips must land in
  const glbRest = new Map<string, THREE.Quaternion>()
  let hipsName = ''
  let glbHips: THREE.Object3D | null = null
  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      if (!glbRest.has(o.name)) glbRest.set(o.name, (o as THREE.Bone).quaternion.clone())
      if (/Hips$/.test(o.name) && !hipsName) {
        hipsName = o.name
        glbHips = o
      }
    }
  })
  // GLB-side hips BIND data for the height retarget below — world-space so armature-node
  // rotations/scales cancel; the emitted track values are hips-local.
  scene.updateMatrixWorld(true)
  const glbHipsWorld = glbHips ? (glbHips as THREE.Object3D).getWorldPosition(new THREE.Vector3()) : null
  const glbHipsParentInv = (glbHips as THREE.Object3D | null)?.parent?.matrixWorld.clone().invert() ?? null
  const out: THREE.AnimationClip[] = []

  for (const source of sources) {
    try {
      const fbx = source.root
      const clip = fbx.animations[0]
      if (!clip) {
        console.warn('anim merge: no clip in', source.name)
        continue
      }
      const fbxRest = new Map<string, THREE.Quaternion>()
      fbx.traverse((o) => {
        if ((o as THREE.Bone).isBone && !fbxRest.has(o.name)) fbxRest.set(o.name, (o as THREE.Bone).quaternion.clone())
      })
      const tracks: THREE.KeyframeTrack[] = clip.tracks
        .filter((t) => /\.quaternion$/.test(t.name))
        .map((t) => {
          const c = t.clone() as THREE.QuaternionKeyframeTrack
          const bone = c.name.replace(/\.quaternion$/, '')
          const rg = glbRest.get(bone)
          if (!rg) return c
          if (bone === hipsName) {
            // plain rest premultiply. (Self-calibrating to the clip's first key looked clever
            // but offset every clip by its lead-in lean — a constant ~7° tilt on idles.)
            premultiplyTrack(c, rg)
          } else {
            const rf = fbxRest.get(bone)
            if (rf) {
              const corr = rg.clone().multiply(rf.clone().invert())
              if (Math.abs(1 - Math.abs(corr.w)) > 1e-4) premultiplyTrack(c, corr) // skip ≈identity
            }
          }
          return c
        })
      // HIPS HEIGHT: rotations alone can't ground a character — pinned at bind height, a walk
      // floats the feet by its hip-drop and a death clip leaves the corpse lying in MID-AIR at
      // standing hip height (the FBX curve carries the hips to ~0 as the body falls). Retarget
      // just the Y curve: world-space delta around the FBX hips REST, scaled by the rigs'
      // hip-height ratio, applied on top of the GLB hips bind. World-space math cancels FBX cm
      // units and armature-node transforms on both sides; X/Z stay dropped → clips remain
      // in place (Mixamo root motion never leaks in).
      const posTrack = clip.tracks.find((t) => t.name === `${hipsName}.position`)
      let fbxHips: THREE.Object3D | null = null
      fbx.traverse((o) => {
        if ((o as THREE.Bone).isBone && o.name === hipsName && !fbxHips) fbxHips = o
      })
      if (posTrack && fbxHips && glbHipsWorld && glbHipsParentInv) {
        fbx.updateMatrixWorld(true)
        const fh = fbxHips as THREE.Object3D
        const fbxHipsWorld = fh.getWorldPosition(new THREE.Vector3())
        const parentW = fh.parent?.matrixWorld ?? new THREE.Matrix4()
        const s = fbxHipsWorld.y > 1e-6 ? glbHipsWorld.y / fbxHipsWorld.y : 0
        if (s > 0) {
          const c = posTrack.clone() as THREE.VectorKeyframeTrack
          const v = c.values
          const p = new THREE.Vector3()
          for (let i = 0; i + 2 < v.length; i += 3) {
            p.set(v[i], v[i + 1], v[i + 2]).applyMatrix4(parentW) // key → world (FBX space)
            const dy = (p.y - fbxHipsWorld.y) * s // height delta around rest, rig-scaled
            p.copy(glbHipsWorld)
            p.y += dy
            p.applyMatrix4(glbHipsParentInv) // world (GLB space) → hips-local track value
            v[i] = p.x
            v[i + 1] = p.y
            v[i + 2] = p.z
          }
          tracks.push(c)
        }
      }
      out.push(new THREE.AnimationClip(source.name, clip.duration, tracks))
    } catch (e) {
      console.warn('anim merge failed:', source.name, e)
    }
  }
  return out
}

// pre-multiply every keyframe of a quaternion track by a fixed correction
function premultiplyTrack(track: THREE.QuaternionKeyframeTrack, corr: THREE.Quaternion): void {
  const q = new THREE.Quaternion()
  const v = track.values
  for (let i = 0; i + 3 < v.length; i += 4) {
    q.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(corr)
    v[i] = q.x
    v[i + 1] = q.y
    v[i + 2] = q.z
    v[i + 3] = q.w
  }
}

// ───────────────────────────────────────────────────────────────── bake

async function main() {
  const argv = process.argv.slice(2)
  const positional: string[] = []
  let maxTex = 0 // 0 = textures ship as authored
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--maxtex') maxTex = Number(argv[++i])
    else if (arg.startsWith('--maxtex=')) maxTex = Number(arg.slice('--maxtex='.length))
    else positional.push(arg)
  }
  const [dir, out] = positional
  const capOk = maxTex === 0 || (Number.isInteger(maxTex) && maxTex > 0)
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() || !capOk) {
    console.error('usage: npx tsx inventory/scripts/bake-gltf.ts <components-dir> [out.glb] [--maxtex <px>]')
    process.exit(1)
  }

  const source = path.join(dir, 'index.glb')
  if (!fs.existsSync(source)) throw new Error(`no index.glb in ${dir}`)
  const animFiles = fs
    .readdirSync(dir)
    .filter((f) => /\.fbx$/i.test(f))
    .sort()
  if (!animFiles.length) throw new Error(`no .fbx animations in ${dir}`)

  const glb = readGlb(source)
  const warn: Warn = (m) => console.warn(`! ${m}`)

  const lifted = rootSkinnedMeshes(glb, warn)
  if (lifted) console.log(`lifted ${lifted} skinned mesh node(s) to the scene root`)
  const tangents = generateTangents(glb, warn)
  if (tangents) console.log(`baked tangents for ${tangents} primitive(s)`)

  // authored/exporter clips (frozen T-poses, "mixamo.com" leftovers) never ship: the sibling
  // FBX set is the components's entire animation vocabulary. Their data falls to the prune below.
  delete glb.json.animations

  const scene = await parseHeadless(glb, dir)

  const fbxLoader = new FBXLoader()
  const sources: FbxAnimSource[] = animFiles.map((file) => ({
    name: file.replace(/\.fbx$/i, ''),
    root: fbxLoader.parse(toArrayBuffer(fs.readFileSync(path.join(dir, file))), dir),
  }))
  const clips = mergeFbxClips(scene, sources)
  injectClips(glb, clips, warn)

  const pruned = pruneUnused(glb, warn)
  if (pruned) console.log(`pruned ${pruned} unused object(s)`)

  if (maxTex) {
    const resized = await resizeTextures(glb, maxTex)
    console.log(resized ? `resized ${resized} texture(s) to ≤${maxTex}px` : `textures already ≤${maxTex}px`)
  }

  const outFile = out ?? path.join(dir, 'index.baked.glb')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, toGlbBuffer(glb))

  console.log(`${outFile}: ${glb.json.animations.length} clip(s)`)
  for (const animation of glb.json.animations) console.log(`  ${animation.name}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
