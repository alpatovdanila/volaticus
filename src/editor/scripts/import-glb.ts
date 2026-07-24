// import-glb.ts — the ONE-COMMAND import pipeline for a GLB character-components folder. Given a
// folder with index.glb (+ optional sibling Mixamo *.fbx), it produces an editor-ready entity.
// Three steps:
//
//   1. NAME animations. The GLB may already have Mixamo clips baked in by Blender (named
//      "mixamo.com*", useless); rename them to their source *.fbx FILENAMES (matched by
//      DURATION), base clip → "index". FBX not baked into the GLB are merged at LOAD (step 3).
//
//   2. REPACK textures (optional, --maxtex N, default 512). Tripo/PBR exports ship 4K maps;
//      downscaling to ≤N px shrinks the file ~50×. Decode → resize (sharp) → re-encode, then
//      rebuild the binary chunk. Everything else (mesh, skeleton, animation data) is untouched.
//
//   3. GENERATE the entity doc → inventory/models/<id>/<id>.json: components.src, sibling FBX to
//      merge (components.anims), a state per clip, and an emissive control for every mesh named
//      "<part>@exposeEmissive" (glow, colour+intensity — tweak live in the editor). Skipped if
//      the doc already exists (won't clobber hand edits) unless --force.
//
//   npx tsx scripts/import-glb.ts [folder] [--maxtex 512] [--id <id>] [--category <cat>] [--force]
//                                 [--gen-float] [--gen-hit]
//     folder      resources-relative, a bare name under resources/models/, or absolute
//                 (default: resources/models/player-test)
//     --maxtex    cap every texture's largest side at N px (omit to skip; bare flag = 512)
//     --id        entity id (default: the folder name, slugified)
//     --category  prop | pickup | enemy | character | levelpart (default: character)
//     --force     regenerate the entity doc even if it exists
//     --gen-float generate a looping "index" hover-bob clip (rigid node animation — no bones;
//                 for floating props/characters that ship without a skeleton)
//     --gen-hit   generate a one-shot "Hit" lean-back clip (also wired as a `hit` event)
//     --gen-sway  PLANT-LIKE props: synthesize a 2-joint stem rig (static base anchor + one
//                 animated bend bone, per-vertex height-gradient weights) and generate a looping
//                 "index" sway — the base stays planted while the top bends
//     --gen-pushback  stem rig + one-shot "Hit" springy pushback (bend away, oscillate back)
//     --recalc-normals  rebuild NORMAL from the geometry (area-weighted, position-welded smooth).
//                 OPT-IN for models whose exported normals are broken. Cons: authored normals are
//                 LOST — hard edges and stylized soft shading smooth out, and a baked normal map's
//                 basis no longer matches exactly (possible seam shading) — so never the default.
//                 NOTE faceted-looking shading is usually NOT broken normals: exports without a
//                 TANGENT attribute facet under a normal map (derivative tangents are per-triangle)
//                 — that case is fixed AUTOMATICALLY by the tangent-generation pass below.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

// ---- args ----
const args = process.argv.slice(2)
let folderArg = ''
let maxTex = 0 // 0 = don't repack
let idArg = ''
let categoryArg = 'character'
let force = false // overwrite an existing entity doc
let genFloat = false // synthesize a looping "index" hover-bob clip (rigid props, no skeleton needed)
let genHit = false // synthesize a one-shot "Hit" lean-back clip
let genSway = false // stem rig + looping "index" sway clip (plant-like props: base planted, top bends)
let genPushback = false // stem rig + one-shot "Hit" pushback (springy bend away, recover)
let recalcNormals = false // rebuild NORMAL from geometry (opt-in — destroys authored normals, see header)
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--maxtex') {
    const n = parseInt(args[i + 1] ?? '', 10)
    maxTex = Number.isFinite(n) && n > 0 ? (i++, n) : 512 // bare flag → 512
  } else if (a.startsWith('--maxtex=')) {
    maxTex = parseInt(a.slice(9), 10) || 512
  } else if (a === '--id') {
    idArg = args[++i] ?? ''
  } else if (a.startsWith('--id=')) {
    idArg = a.slice(5)
  } else if (a === '--category') {
    categoryArg = args[++i] ?? categoryArg
  } else if (a.startsWith('--category=')) {
    categoryArg = a.slice(11)
  } else if (a === '--force') {
    force = true
  } else if (a === '--gen-float') {
    genFloat = true
  } else if (a === '--gen-hit') {
    genHit = true
  } else if (a === '--gen-sway') {
    genSway = true
  } else if (a === '--gen-pushback') {
    genPushback = true
  } else if (a === '--recalc-normals') {
    recalcNormals = true
  } else if (!a.startsWith('--')) {
    folderArg = a
  }
}
// a bare name (no slash) resolves under resources/models/; a path/absolute is used as-is
const dir = !folderArg
  ? path.resolve(ROOT, 'resources/models/player-test')
  : path.isAbsolute(folderArg) || /[\\/]/.test(folderArg)
    ? path.resolve(ROOT, folderArg)
    : path.resolve(ROOT, 'resources/models', folderArg)
const glbPath = path.join(dir, 'index.glb')

// ---- 1. FBX clip durations + names (the naming source) ----
const loader = new FBXLoader()
const fbxAnims: { name: string; dur: number }[] = []
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.fbx'))) {
  const buf = fs.readFileSync(path.join(dir, f))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const obj = loader.parse(ab, path.join(dir, f)) as unknown as { animations: { duration: number }[] }
  const clip = obj.animations?.[0]
  if (clip) fbxAnims.push({ name: f.replace(/\.fbx$/i, ''), dur: clip.duration })
}
console.log(`FBX clips: ${fbxAnims.map((f) => `"${f.name}"(${f.dur.toFixed(2)}s)`).join(', ') || '(none)'}`)

// ---- parse GLB into { json, bin } ----
const glb = fs.readFileSync(glbPath)
if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)')
let off = 12
let jsonBuf: Buffer | null = null
let binBuf: Buffer | null = null
while (off < glb.length) {
  const clen = glb.readUInt32LE(off)
  const ctype = glb.readUInt32LE(off + 4)
  const data = glb.subarray(off + 8, off + 8 + clen)
  if (ctype === JSON_CHUNK) jsonBuf = data
  else if (ctype === BIN_CHUNK) binBuf = data
  off += 8 + clen
}
if (!jsonBuf || !binBuf) throw new Error('GLB missing JSON or BIN chunk')
const json = JSON.parse(new TextDecoder().decode(jsonBuf))

// ---- 2a. name animations (matched by duration) ----
interface GlbAnim {
  a: { name: string; samplers: { input: number }[] }
  dur: number
}
const glbAnims: GlbAnim[] = (json.animations ?? []).map((a: GlbAnim['a']) => {
  let dur = 0
  for (const s of a.samplers) {
    const acc = json.accessors[s.input]
    if (acc?.max) dur = Math.max(dur, acc.max[0])
  }
  return { a, dur }
})
if (glbAnims.length) {
  // Baked GLB clips are NEVER matched/renamed to FBX names: all sibling FBX are merged at
  // LOAD and a same-name merged clip OVERRIDES the baked one — so a baked clip renamed to an
  // FBX name simply vanishes from the selector (a unique authored clip whose duration merely
  // resembled an FBX's was being swallowed this way). Rules instead:
  //   • meaningful name, no FBX collision → kept as-is (the authored clip survives)
  //   • junk exporter name (mixamo.com*, NlaTrack*, …) OR a name colliding with a sibling
  //     FBX clip → renamed to "index"/"index.NNN" (base clip convention; collision rename
  //     also repairs GLBs the old matcher already wrote)
  const JUNK_NAME = /^(mixamo\.com|nlatrack|take[ _]?\d|animation|armature|scene)/i
  const fbxNames = new Set(fbxAnims.map((f) => f.name))
  let baseN = 0
  for (const ga of glbAnims) {
    const junk = JUNK_NAME.test(ga.a.name)
    const collides = fbxNames.has(ga.a.name)
    if (!junk && !collides) {
      console.log(`  "${ga.a.name}"  kept (authored clip, ${ga.dur.toFixed(2)}s)`)
      continue
    }
    let name: string
    do {
      name = baseN === 0 ? 'index' : `index.${String(baseN).padStart(3, '0')}`
      baseN++
    } while (fbxNames.has(name))
    console.log(
      `  "${name}"  ←  baked clip ${ga.dur.toFixed(2)}s (${junk ? 'junk name "' + ga.a.name + '"' : 'name collided with FBX "' + ga.a.name + '"'})`,
    )
    ga.a.name = name
  }
}

// ---- 2b. repack textures (optional) — rebuild the BIN with downscaled images ----
async function repack(): Promise<void> {
  if (!maxTex) return
  const images: { name: string; mime: string; bv: number }[] = (json.images ?? [])
    .map((img: { name?: string; mimeType?: string; bufferView?: number }) => ({
      name: img.name ?? '?',
      mime: img.mimeType ?? 'image/png',
      bv: img.bufferView ?? -1,
    }))
    .filter((i: { bv: number }) => i.bv >= 0)
  if (!images.length) {
    console.log('repack: no embedded-buffer images to resize')
    return
  }
  console.log(`\nrepack → max ${maxTex}px:`)
  const newData = new Map<number, Buffer>() // bufferView index → resized bytes
  for (const img of images) {
    const bv = json.bufferViews[img.bv]
    const src = binBuf!.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
    const meta = await sharp(src).metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (Math.max(w, h) <= maxTex) {
      console.log(`  ${img.name.slice(0, 42)}  ${w}×${h}  (already ≤${maxTex}, kept)`)
      continue
    }
    const pipe = sharp(src).resize({ width: maxTex, height: maxTex, fit: 'inside', withoutEnlargement: true })
    const out =
      img.mime === 'image/jpeg'
        ? await pipe.jpeg({ quality: 90 }).toBuffer()
        : await pipe.png({ compressionLevel: 9 }).toBuffer()
    newData.set(img.bv, out)
    console.log(
      `  ${img.name.slice(0, 42)}  ${w}×${h} → ≤${maxTex}   ${(bv.byteLength / 1e6).toFixed(1)}MB → ${(out.length / 1e6).toFixed(2)}MB`,
    )
  }
  if (!newData.size) return

  // Rebuild the single binary buffer: walk every bufferView in on-disk order, copy its bytes
  // (resized image bytes where we have them) to a fresh 4-byte-aligned offset. Accessors
  // reference bufferViews by INDEX and keep their own in-view byteOffset, so only the
  // bufferView's position in the buffer moves — which is exactly what byteOffset encodes.
  interface BV {
    idx: number
    bv: { buffer: number; byteOffset?: number; byteLength: number }
    data: Buffer
  }
  const bvs: BV[] = json.bufferViews.map((bv: BV['bv'], idx: number) => ({
    idx,
    bv,
    data: newData.get(idx) ?? binBuf!.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength),
  }))
  bvs.sort((a, b) => (a.bv.byteOffset ?? 0) - (b.bv.byteOffset ?? 0))
  const parts: Buffer[] = []
  let cursor = 0
  for (const e of bvs) {
    const pad = (4 - (cursor % 4)) % 4
    if (pad) {
      parts.push(Buffer.alloc(pad))
      cursor += pad
    }
    e.bv.byteOffset = cursor
    e.bv.byteLength = e.data.length
    parts.push(e.data)
    cursor += e.data.length
  }
  binBuf = Buffer.concat(parts)
  json.buffers[0].byteLength = binBuf.length
}

// ---- 2c. generate animations (optional) — rigid node-transform clips, NO skeleton needed ----
// glTF clips can target plain NODES, so a floating/hovering prop needs no bone: we synthesize
// keyframes against the components's scene-root node (the whole components moves as one rigid transform).
// A 1-bone rigid skin would render identically but pay per-vertex skinning forever — never do it.
//   --gen-float → "index": looping hover-bob (position.y sine, ~3.2s)
//   --gen-hit   → "Hit":   one-shot lean-back (rotation kick + recover, ~0.55s)
// Idempotent: same-name animations are replaced on re-run (their old buffer bytes are dropped by
// the bufferView rebuild on the next --maxtex repack; the few KB are harmless meanwhile).
function appendBufferView(data: Buffer): number {
  const pad = (4 - (binBuf!.length % 4)) % 4
  if (pad) binBuf = Buffer.concat([binBuf!, Buffer.alloc(pad)])
  const idx = json.bufferViews.length
  json.bufferViews.push({ buffer: 0, byteOffset: binBuf!.length, byteLength: data.length })
  binBuf = Buffer.concat([binBuf!, data])
  return idx
}
const COMPS: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }
function appendAccessor(floats: number[], type: 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4', withMinMax: boolean): number {
  const buf = Buffer.alloc(floats.length * 4)
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4)
  const comps = COMPS[type]
  const count = floats.length / comps
  const acc: Record<string, unknown> = { bufferView: appendBufferView(buf), componentType: 5126, count, type }
  if (withMinMax) {
    // per-component min/max (REQUIRED on animation-sampler inputs by the glTF spec)
    const min = Array(comps).fill(Infinity)
    const max = Array(comps).fill(-Infinity)
    for (let i = 0; i < floats.length; i++) {
      const c = i % comps
      min[c] = Math.min(min[c], floats[i])
      max[c] = Math.max(max[c], floats[i])
    }
    acc.min = min
    acc.max = max
  }
  const idx = json.accessors.length
  json.accessors.push(acc)
  return idx
}
// unsigned-byte VEC4 accessor (JOINTS_0 — plain integer joint indices, never normalized)
function appendAccessorU8Vec4(bytes: number[]): number {
  const acc = {
    bufferView: appendBufferView(Buffer.from(bytes)),
    componentType: 5121,
    count: bytes.length / 4,
    type: 'VEC4',
  }
  const idx = json.accessors.length
  json.accessors.push(acc)
  return idx
}
// read/write a float32 VEC3 attribute in place (handles accessor/view offsets + optional stride)
function vec3Attr(accIdx: number): {
  count: number
  get(i: number): [number, number, number]
  set(i: number, v: [number, number, number]): void
  acc: Record<string, unknown>
} {
  const acc = json.accessors[accIdx]
  if (acc.componentType !== 5126 || acc.type !== 'VEC3') throw new Error('expected float32 VEC3 accessor')
  const bv = json.bufferViews[acc.bufferView]
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = bv.byteStride ?? 12
  return {
    count: acc.count,
    acc,
    get(i) {
      const o = base + i * stride
      return [binBuf!.readFloatLE(o), binBuf!.readFloatLE(o + 4), binBuf!.readFloatLE(o + 8)]
    },
    set(i, v) {
      const o = base + i * stride
      binBuf!.writeFloatLE(v[0], o)
      binBuf!.writeFloatLE(v[1], o + 4)
      binBuf!.writeFloatLE(v[2], o + 8)
    },
  }
}
// q = a * b (Hamilton product, [x,y,z,w])
function quatMul(a: number[], b: number[]): number[] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}
// ---- 2d. stem rig (optional) — for PLANT-LIKE props (--gen-sway / --gen-pushback) ----
// A flower must BEND: base planted, deflection growing with height. One rigidly-weighted bone
// can't bend (that's just a rigid tilt = plain node animation) — a bend needs a per-vertex
// weight GRADIENT, which needs TWO joints to blend between: a static "stem_root" anchor and one
// ANIMATED "stem_bend" bone, both pivoted at the components's base. Vertices weight root→bend by
// normalized height, so rotating stem_bend tips the top the most → smooth stem bend.
//
// The synthesis: bake each mesh node's transform into its POSITION/NORMAL data (vertices land in
// scene space — spec-clean skinning for ANY viewer incl. Blender), add the two joint nodes + a
// skin whose IBMs are a pure -base translation, and give every primitive JOINTS_0/WEIGHTS_0 from
// vertex height. Skipped when the GLB already has a skin (a real skeleton, or ours on a re-run).
function quatToMat3(q: number[]): number[] {
  const [x, y, z, w] = q
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
  ] // column-major 3×3
}
interface Xform {
  m: number[]
  t: number[]
} // linear part (col-major 3×3) + translation
function nodeXform(n: { translation?: number[]; rotation?: number[]; scale?: number[] }): Xform {
  const r = quatToMat3(n.rotation ?? [0, 0, 0, 1])
  const s = n.scale ?? [1, 1, 1]
  // columns scaled by the node scale (R·S)
  const m = [
    r[0] * s[0],
    r[1] * s[0],
    r[2] * s[0],
    r[3] * s[1],
    r[4] * s[1],
    r[5] * s[1],
    r[6] * s[2],
    r[7] * s[2],
    r[8] * s[2],
  ]
  return { m, t: n.translation ?? [0, 0, 0] }
}
function xformCompose(p: Xform, c: Xform): Xform {
  const a = p.m
  const b = c.m
  const m = new Array(9).fill(0)
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 3; row++)
      m[col * 3 + row] = a[row] * b[col * 3] + a[3 + row] * b[col * 3 + 1] + a[6 + row] * b[col * 3 + 2]
  return { m, t: [0, 1, 2].map((r) => p.t[r] + a[r] * c.t[0] + a[3 + r] * c.t[1] + a[6 + r] * c.t[2]) }
}
function xformPoint(x: Xform, v: [number, number, number]): [number, number, number] {
  const { m, t } = x
  return [
    t[0] + m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    t[1] + m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    t[2] + m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ]
}
function synthesizeStemRig(): void {
  if (!genSway && !genPushback) return
  if (json.skins?.length) {
    console.log('stem rig: GLB already has a skin — reusing (clips will target "stem_bend" if present)')
    return
  }
  // mesh-bearing nodes with their GLOBAL transforms (walk the scene graph)
  const meshNodes: { idx: number; x: Xform }[] = []
  const walk = (idx: number, parent: Xform) => {
    const n = json.nodes[idx]
    const x = xformCompose(parent, nodeXform(n))
    if (n.mesh != null) meshNodes.push({ idx, x })
    for (const c of n.children ?? []) walk(c, x)
  }
  const identity: Xform = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }
  for (const r of json.scenes[json.scene ?? 0].nodes) walk(r, identity)
  if (!meshNodes.length) throw new Error('stem rig: no meshes in scene')

  // 1) bake node transforms into vertex data (positions AND normals land in scene space)
  let min = [Infinity, Infinity, Infinity]
  let max = [-Infinity, -Infinity, -Infinity]
  const baked = new Set<number>() // accessor indices already rewritten (shared accessors bake once)
  for (const { idx, x } of meshNodes) {
    const n = json.nodes[idx]
    for (const prim of json.meshes[n.mesh].primitives) {
      const pos = vec3Attr(prim.attributes.POSITION)
      if (!baked.has(prim.attributes.POSITION)) {
        baked.add(prim.attributes.POSITION)
        const pMin = [Infinity, Infinity, Infinity]
        const pMax = [-Infinity, -Infinity, -Infinity]
        for (let i = 0; i < pos.count; i++) {
          const w = xformPoint(x, pos.get(i))
          pos.set(i, w)
          for (let c = 0; c < 3; c++) {
            pMin[c] = Math.min(pMin[c], w[c])
            pMax[c] = Math.max(pMax[c], w[c])
          }
        }
        pos.acc.min = pMin // POSITION accessors REQUIRE min/max — keep them true
        pos.acc.max = pMax
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c], pMin[c])
          max[c] = Math.max(max[c], pMax[c])
        }
      }
      if (prim.attributes.NORMAL != null && !baked.has(prim.attributes.NORMAL)) {
        baked.add(prim.attributes.NORMAL)
        const nrm = vec3Attr(prim.attributes.NORMAL)
        const rot: Xform = { m: x.m, t: [0, 0, 0] }
        for (let i = 0; i < nrm.count; i++) {
          const v = xformPoint(rot, nrm.get(i))
          const l = Math.hypot(v[0], v[1], v[2]) || 1 // uniform scale → renormalize is exact
          nrm.set(i, [v[0] / l, v[1] / l, v[2] / l])
        }
      }
    }
    delete n.translation // transform is baked in — the node is identity now
    delete n.rotation
    delete n.scale
    delete n.matrix
  }

  // 2) joints: static anchor + bend bone, both pivoted at the base (bbox bottom-centre)
  const base = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2]
  const bendIdx = json.nodes.push({ name: 'stem_bend' }) - 1
  const rootIdx = json.nodes.push({ name: 'stem_root', translation: base, children: [bendIdx] }) - 1
  json.scenes[json.scene ?? 0].nodes.push(rootIdx)
  // IBM = inverse(T(base)) for both joints (vertices are in scene space post-bake)
  const ibm = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -base[0], -base[1], -base[2], 1]
  json.skins = [
    {
      inverseBindMatrices: appendAccessor([...ibm, ...ibm], 'MAT4', false),
      joints: [rootIdx, bendIdx],
      skeleton: rootIdx,
    },
  ]

  // 3) per-vertex weights: height-gradient root→bend (smoothstep, small planted dead-zone)
  const h0 = min[1]
  const hSpan = Math.max(1e-6, max[1] - min[1])
  const skinned = new Set<number>()
  for (const { idx } of meshNodes) {
    const n = json.nodes[idx]
    n.skin = 0
    for (const prim of json.meshes[n.mesh].primitives) {
      if (skinned.has(prim.attributes.POSITION)) continue // shared position accessor → same weights
      skinned.add(prim.attributes.POSITION)
      const pos = vec3Attr(prim.attributes.POSITION)
      const joints: number[] = []
      const weights: number[] = []
      for (let i = 0; i < pos.count; i++) {
        let h = (pos.get(i)[1] - h0) / hSpan
        h = Math.min(1, Math.max(0, (h - 0.04) / 0.96)) // bottom 4% fully planted
        const w = h * h * (3 - 2 * h) // smoothstep — bend eases in along the stem
        joints.push(0, 1, 0, 0)
        weights.push(1 - w, w, 0, 0)
      }
      prim.attributes.JOINTS_0 = appendAccessorU8Vec4(joints)
      prim.attributes.WEIGHTS_0 = appendAccessor(weights, 'VEC4', false)
    }
  }
  json.buffers[0].byteLength = binBuf!.length
  console.log(
    `  stem rig: ${meshNodes.length} mesh(es) skinned to stem_root+stem_bend @ base [${base.map((v) => v.toFixed(3)).join(', ')}], height ${hSpan.toFixed(2)}m`,
  )
}

// ---- 2e. forced normal recompute (optional, --recalc-normals) ----
// Area-weighted face normals accumulated per POSITION-WELDED vertex (duplicates along UV
// seams share one smooth normal — no split-shading seams), then normalized back into the
// NORMAL attribute in place. Geometry, UVs, skin weights untouched.
function readIndices(accIdx: number): number[] {
  const acc = json.accessors[accIdx]
  const bv = json.bufferViews[acc.bufferView]
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const out: number[] = []
  for (let i = 0; i < acc.count; i++) {
    if (acc.componentType === 5125) out.push(binBuf!.readUInt32LE(base + i * 4))
    else if (acc.componentType === 5123) out.push(binBuf!.readUInt16LE(base + i * 2))
    else out.push(binBuf!.readUInt8(base + i))
  }
  return out
}
function recalcNormalsPass(): void {
  if (!recalcNormals) return
  let meshCount = 0
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      if (prim.attributes.NORMAL == null || prim.attributes.POSITION == null) continue
      const pos = vec3Attr(prim.attributes.POSITION)
      const nrm = vec3Attr(prim.attributes.NORMAL)
      const idx = prim.indices != null ? readIndices(prim.indices) : [...Array(pos.count).keys()]
      // weld by position so seam-duplicated vertices share one smooth normal
      const weld = new Map<string, number[]>() // key → accumulated normal
      const keyOf = (i: number) => {
        const p = pos.get(i)
        return p[0].toFixed(4) + ',' + p[1].toFixed(4) + ',' + p[2].toFixed(4)
      }
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = pos.get(idx[t])
        const b = pos.get(idx[t + 1])
        const c = pos.get(idx[t + 2])
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
        // cross(ab, ac) — length ∝ 2×area, so accumulation is area-weighted for free
        const fn = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
        for (const vi of [idx[t], idx[t + 1], idx[t + 2]]) {
          const k = keyOf(vi)
          const acc = weld.get(k)
          if (acc) {
            acc[0] += fn[0]
            acc[1] += fn[1]
            acc[2] += fn[2]
          } else weld.set(k, [...fn])
        }
      }
      for (let i = 0; i < pos.count; i++) {
        const n = weld.get(keyOf(i))
        if (!n) continue
        const l = Math.hypot(n[0], n[1], n[2]) || 1
        nrm.set(i, [n[0] / l, n[1] / l, n[2] / l])
      }
      meshCount++
    }
  }
  console.log(`  recalc-normals: rebuilt ${meshCount} primitive(s) (area-weighted, position-welded)`)
}

// ---- 2f′. degenerate normal-map strip (AUTOMATIC) ----
// Some exports ship a normal map that is a near-CONSTANT off-neutral color (std ≈ 0, mean far
// from [128,128,255]). Such a map carries zero surface detail — it only bends every normal by a
// constant tangent-space tilt, which points a different way on every face/UV island and shades
// as FACETS. Stripping the reference is strictly better. Real normal maps (per-channel std in
// the tens) are never touched.
async function stripDegenerateNormalMapsPass(): Promise<void> {
  for (const mat of json.materials ?? []) {
    const nt = mat.normalTexture
    if (nt == null) continue
    const img = json.images?.[json.textures?.[nt.index]?.source]
    if (img?.bufferView == null) continue
    const bv = json.bufferViews[img.bufferView]
    const bytes = binBuf!.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
    const n = info.width * info.height
    const ch = info.channels
    const mean = [0, 0, 0]
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += data[i * ch + c]
    for (let c = 0; c < 3; c++) mean[c] /= n
    let stdMax = 0
    for (let c = 0; c < 3; c++) {
      let v = 0
      for (let i = 0; i < n; i++) {
        const d = data[i * ch + c] - mean[c]
        v += d * d
      }
      stdMax = Math.max(stdMax, Math.sqrt(v / n))
    }
    if (stdMax < 8) {
      delete mat.normalTexture
      console.log(
        `  normal map "${img.name ?? '?'}" is DEGENERATE (near-constant, std ${stdMax.toFixed(1)}, mean [${mean.map((m) => m.toFixed(0)).join(',')}] vs neutral [128,128,255]) — stripped (it only adds a constant biased tilt → per-face faceting)`,
      )
    }
  }
}

// ---- 2f. tangent generation (AUTOMATIC when missing) ----
// Exports that ship a normal map but NO TANGENT attribute force the renderer onto screen-space
// derivative tangents, which are CONSTANT PER TRIANGLE — a strong normal map then shades as
// visible facets ("flat shading" look) even with perfectly smooth vertex normals. The glTF spec
// says such meshes should carry tangents, so we synthesize them (Lengyel per-triangle from UVs,
// accumulated per vertex, orthonormalized, w = handedness). Additive + lossless (+16B/vertex).
function generateTangentsPass(): void {
  let count = 0
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const a = prim.attributes
      if (a.TANGENT != null || a.NORMAL == null || a.POSITION == null || a.TEXCOORD_0 == null) continue
      const pos = vec3Attr(a.POSITION)
      const nrm = vec3Attr(a.NORMAL)
      // uv reader (float32 VEC2)
      const uvAcc = json.accessors[a.TEXCOORD_0]
      if (uvAcc.componentType !== 5126 || uvAcc.type !== 'VEC2') continue
      const uvBv = json.bufferViews[uvAcc.bufferView]
      const uvBase = (uvBv.byteOffset ?? 0) + (uvAcc.byteOffset ?? 0)
      const uvStride = uvBv.byteStride ?? 8
      const uv = (i: number): [number, number] => [
        binBuf!.readFloatLE(uvBase + i * uvStride),
        binBuf!.readFloatLE(uvBase + i * uvStride + 4),
      ]
      const idx = prim.indices != null ? readIndices(prim.indices) : [...Array(pos.count).keys()]

      const tan1 = new Float64Array(pos.count * 3)
      const tan2 = new Float64Array(pos.count * 3)
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const [i1, i2, i3] = [idx[t], idx[t + 1], idx[t + 2]]
        const p1 = pos.get(i1)
        const p2 = pos.get(i2)
        const p3 = pos.get(i3)
        const w1 = uv(i1)
        const w2 = uv(i2)
        const w3 = uv(i3)
        const x1 = p2[0] - p1[0],
          y1 = p2[1] - p1[1],
          z1 = p2[2] - p1[2]
        const x2 = p3[0] - p1[0],
          y2 = p3[1] - p1[1],
          z2 = p3[2] - p1[2]
        const s1 = w2[0] - w1[0],
          t1 = w2[1] - w1[1]
        const s2 = w3[0] - w1[0],
          t2 = w3[1] - w1[1]
        const denom = s1 * t2 - s2 * t1
        if (Math.abs(denom) < 1e-12) continue // degenerate UV mapping — skip
        const r = 1 / denom
        const sd = [(t2 * x1 - t1 * x2) * r, (t2 * y1 - t1 * y2) * r, (t2 * z1 - t1 * z2) * r]
        const td = [(s1 * x2 - s2 * x1) * r, (s1 * y2 - s2 * y1) * r, (s1 * z2 - s2 * z1) * r]
        for (const vi of [i1, i2, i3]) {
          tan1[vi * 3] += sd[0]
          tan1[vi * 3 + 1] += sd[1]
          tan1[vi * 3 + 2] += sd[2]
          tan2[vi * 3] += td[0]
          tan2[vi * 3 + 1] += td[1]
          tan2[vi * 3 + 2] += td[2]
        }
      }
      const out: number[] = []
      for (let i = 0; i < pos.count; i++) {
        const n = nrm.get(i)
        const t = [tan1[i * 3], tan1[i * 3 + 1], tan1[i * 3 + 2]]
        // Gram-Schmidt orthonormalize against the normal
        const nd = n[0] * t[0] + n[1] * t[1] + n[2] * t[2]
        let tx = t[0] - n[0] * nd,
          ty = t[1] - n[1] * nd,
          tz = t[2] - n[2] * nd
        const l = Math.hypot(tx, ty, tz)
        if (l < 1e-8) {
          out.push(1, 0, 0, 1) // degenerate — arbitrary orthogonal default
          continue
        }
        tx /= l
        ty /= l
        tz /= l
        // handedness: sign of dot(cross(n, t), tan2)
        const cx = n[1] * tz - n[2] * ty,
          cy = n[2] * tx - n[0] * tz,
          cz = n[0] * ty - n[1] * tx
        const w = cx * tan2[i * 3] + cy * tan2[i * 3 + 1] + cz * tan2[i * 3 + 2] < 0 ? -1 : 1
        out.push(tx, ty, tz, w)
      }
      prim.attributes.TANGENT = appendAccessor(out, 'VEC4', false)
      count++
    }
  }
  if (count) {
    json.buffers[0].byteLength = binBuf!.length
    console.log(`  tangents: generated for ${count} primitive(s) (missing TANGENT + normal-mapped shading would facet)`)
  }
}

function generateAnims(): void {
  if (!genFloat && !genHit && !genSway && !genPushback) return
  json.animations ??= []
  const rootIdx: number = json.scenes[json.scene ?? 0].nodes[0]
  const root = json.nodes[rootIdx]
  if (!root.name) root.name = 'modelRoot' // three binds tracks by node NAME — it must have one
  const baseT: number[] = root.translation ?? [0, 0, 0]
  const baseR: number[] = root.rotation ?? [0, 0, 0, 1]
  const replace = (name: string) => {
    json.animations = json.animations.filter((a: { name: string }) => a.name !== name)
  }

  // stem clips target the bend joint (post-bake its bind rotation is identity and its axes are
  // WORLD axes: X = front/back pitch, Z = side roll — the base stays planted, the top bends)
  const bendIdx = json.nodes.findIndex((n: { name?: string }) => n.name === 'stem_bend')
  if ((genSway || genPushback) && bendIdx < 0)
    throw new Error('--gen-sway/--gen-pushback need the stem rig (no "stem_bend" joint found)')
  const eulerXZ = (xDeg: number, zDeg: number): number[] => {
    const hx = (xDeg * Math.PI) / 360
    const hz = (zDeg * Math.PI) / 360
    return quatMul([Math.sin(hx), 0, 0, Math.cos(hx)], [0, 0, Math.sin(hz), Math.cos(hz)])
  }
  if (genSway) {
    replace('index')
    // gentle elliptical sway: two out-of-phase sines so the tip traces an oval, never a metronome
    const T = 4.2
    const N = 43
    const ax = 3.5
    const az = 2.5
    const times: number[] = []
    const values: number[] = []
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * T
      times.push(t)
      const ph = (2 * Math.PI * t) / T
      values.push(...eulerXZ(ax * Math.sin(ph), az * Math.sin(ph + Math.PI / 2)))
    }
    json.animations.push({
      name: 'index',
      channels: [{ sampler: 0, target: { node: bendIdx, path: 'rotation' } }],
      samplers: [
        {
          input: appendAccessor(times, 'SCALAR', true),
          output: appendAccessor(values, 'VEC4', false),
          interpolation: 'LINEAR',
        },
      ],
    })
    console.log(`  generated "index" (stem sway ${T}s, ±${ax}°/${az}°) → joint "stem_bend"`)
  }
  if (genPushback) {
    replace('Hit')
    // springy pushback: hard bend away from the front (-X pitch), then oscillating recovery
    const keys: [number, number][] = [
      [0, 0],
      [0.1, -18],
      [0.28, 6],
      [0.46, -2.5],
      [0.65, 0],
    ]
    json.animations.push({
      name: 'Hit',
      channels: [{ sampler: 0, target: { node: bendIdx, path: 'rotation' } }],
      samplers: [
        {
          input: appendAccessor(
            keys.map(([t]) => t),
            'SCALAR',
            true,
          ),
          output: appendAccessor(
            keys.flatMap(([, d]) => eulerXZ(d, 0)),
            'VEC4',
            false,
          ),
          interpolation: 'LINEAR',
        },
      ],
    })
    console.log(`  generated "Hit" (stem pushback 0.65s, 18° spring) → joint "stem_bend"`)
  }
  if (genFloat) {
    replace('index')
    // hover-bob: y = base + amp·sin(2πt/T), sampled densely enough that LINEAR reads smooth
    const T = 3.2
    const N = 33
    const amp = 0.05
    const times: number[] = []
    const values: number[] = []
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * T
      times.push(t)
      values.push(baseT[0], baseT[1] + amp * Math.sin((2 * Math.PI * t) / T), baseT[2])
    }
    json.animations.push({
      name: 'index',
      channels: [{ sampler: 0, target: { node: rootIdx, path: 'translation' } }],
      samplers: [
        {
          input: appendAccessor(times, 'SCALAR', true),
          output: appendAccessor(values, 'VEC3', false),
          interpolation: 'LINEAR',
        },
      ],
    })
    console.log(`  generated "index" (hover-bob ${T}s, ±${amp}m) → node "${root.name}"`)
  }
  if (genHit) {
    replace('Hit')
    // lean back (top tips away from facing +Z = NEGATIVE rotation about parent X), then recover
    // with a small overshoot. Composed onto the root's bind rotation in the parent frame.
    const keys: [number, number][] = [
      [0, 0],
      [0.12, -16],
      [0.34, 3],
      [0.55, 0],
    ]
    const times = keys.map(([t]) => t)
    const values: number[] = []
    for (const [, deg] of keys) {
      const h = (deg * Math.PI) / 360 // θ/2 in radians
      values.push(...quatMul([Math.sin(h), 0, 0, Math.cos(h)], baseR))
    }
    json.animations.push({
      name: 'Hit',
      channels: [{ sampler: 0, target: { node: rootIdx, path: 'rotation' } }],
      samplers: [
        {
          input: appendAccessor(times, 'SCALAR', true),
          output: appendAccessor(values, 'VEC4', false),
          interpolation: 'LINEAR',
        },
      ],
    })
    console.log(`  generated "Hit" (lean-back 0.55s, 16°) → node "${root.name}"`)
  }
  json.buffers[0].byteLength = binBuf!.length
}

// ---- write the GLB back out ----
async function main(): Promise<void> {
  await repack()
  await stripDegenerateNormalMapsPass()
  synthesizeStemRig()
  recalcNormalsPass()
  generateTangentsPass()
  generateAnims()
  const enc = new TextEncoder().encode(JSON.stringify(json))
  const jsonPad = (4 - (enc.length % 4)) % 4
  const jsonLen = enc.length + jsonPad
  const binPad = (4 - (binBuf!.length % 4)) % 4
  const binLen = binBuf!.length + binPad
  const total = 12 + 8 + jsonLen + 8 + binLen
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546c67, 0) // 'glTF'
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  let o = 12
  out.writeUInt32LE(jsonLen, o)
  out.writeUInt32LE(JSON_CHUNK, o + 4)
  o += 8
  Buffer.from(enc).copy(out, o)
  for (let i = 0; i < jsonPad; i++) out[o + enc.length + i] = 0x20 // space pad
  o += jsonLen
  out.writeUInt32LE(binLen, o)
  out.writeUInt32LE(BIN_CHUNK, o + 4)
  o += 8
  binBuf!.copy(out, o)

  // sanity re-parse before touching disk
  const check = JSON.parse(new TextDecoder().decode(out.subarray(20, 20 + enc.length)))
  if (!Array.isArray(check.animations)) throw new Error('rewrite sanity check failed')

  const before = glb.length
  fs.writeFileSync(glbPath, out)
  console.log(
    `\nwrote ${glbPath}  ${(before / 1e6).toFixed(1)}MB → ${(total / 1e6).toFixed(1)}MB` +
      `\nanimations: ${json.animations?.map((a: { name: string }) => a.name).join(', ') ?? '(none)'}`,
  )
}

await main()

// ---- 3. generate the entity doc (so the components shows up in the editor, ready to use) ----
function generateEntityDoc(): void {
  const id = (idArg || path.basename(dir))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const entDir = path.resolve(ROOT, 'inventory', 'entities', id)
  const entFile = path.join(entDir, `${id}.json`)
  if (fs.existsSync(entFile) && !force) {
    console.log(`\nentity ${id}.json already exists — kept (pass --force to regenerate). Model file was still updated.`)
    return
  }
  // --force regenerates the doc but PRESERVES hand-edits: modifiers, events (dismemberment
  // wiring etc.) and tuned emissive values carry over from the existing doc.
  let prev: Record<string, any> | null = null
  if (fs.existsSync(entFile)) {
    try {
      prev = JSON.parse(fs.readFileSync(entFile, 'utf8'))
    } catch {
      /* unreadable — regenerate from scratch */
    }
  }

  // GLB is served from resources/; src is the resources-relative path with '/' separators
  const src = path.relative(path.resolve(ROOT, 'resources'), glbPath).replace(/\\/g, '/')

  // final clip names already in the GLB (after step 1 naming) + emissive parts from mesh names
  const glbClipNames: string[] = (json.animations ?? []).map((a: { name: string }) => a.name)
  const meshNodeNames: string[] = (json.nodes ?? [])
    .filter((n: { mesh?: number }) => n.mesh != null)
    .map((n: { name?: string }) => n.name ?? '')
  const emissive: Record<string, { color: string; intensity: number }> = {}
  for (const nm of meshNodeNames) {
    const m = /^(.+?)@exposeEmissive/.exec(nm)
    if (!m) continue
    // keep the previously tuned glow if the part still exists; default for new parts
    emissive[m[1]] = prev?.model?.emissive?.[m[1]] ?? { color: '#66ccff', intensity: 2.5 }
  }

  // merge ALL sibling FBX at load (components.anims) — even when a baked GLB clip matches by name/
  // duration. The FBX sources are ground truth: some Blender exports bake the NLA in the wrong
  // frame (a broken bake plays face-down), and a same-name merged clip cleanly overrides the
  // baked one at play time. Baked clips with no FBX counterpart (e.g. an "index" base) survive.
  const animFiles = fs
    .readdirSync(dir)
    .filter((x) => x.toLowerCase().endsWith('.fbx') && fbxAnims.some((m) => x.replace(/\.fbx$/i, '') === m.name))

  // every playable clip = GLB clips + merged FBX (deduped) → one state each. Hit-like clips
  // ALSO become one-shot EVENTS (overlay: the reaction plays, then the state clip resumes).
  const clipNames = [...new Set([...glbClipNames, ...fbxAnims.map((f) => f.name)])]
  const initial = clipNames.includes('index') ? 'index' : clipNames[0]
  const states: Record<string, unknown> = { initial }
  for (const c of clipNames) states[c] = { anim: c }
  const events: Record<string, unknown> = {}
  for (const c of clipNames) if (/hit/i.test(c)) events[c] = { anim: c }

  const model: Record<string, unknown> = { src }
  if (animFiles.length) model.anims = animFiles
  if (Object.keys(emissive).length) model.emissive = emissive
  // dismemberable parts (editor checkboxes → components.dismember) survive a --force regen,
  // dropping entries whose mesh no longer exists in the re-exported GLB
  const prevDismember = prev?.model?.dismember
  if (prevDismember) {
    const kept = Object.fromEntries(Object.entries(prevDismember).filter(([p]) => meshNodeNames.includes(p)))
    if (Object.keys(kept).length) model.dismember = kept
  }

  const doc: Record<string, unknown> = {
    format: 1,
    id,
    name: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    category: categoryArg,
    notes: `Imported GLB via scripts/import-glb.ts. Parts: ${meshNodeNames.join(', ')}. Clips: ${clipNames.join(', ') || '(none)'}.`,
    model,
    materials: {},
    rig: {},
  }
  if (clipNames.length) doc.states = states // an animation-less prop is legal — just no states
  // hand-edits survive a --force regen: modifiers + events carry over (generated hit-events
  // only fill in when the previous doc had none)
  if (prev?.modifiers && Object.keys(prev.modifiers).length) doc.modifiers = prev.modifiers
  if (prev?.events && Object.keys(prev.events).length) doc.events = prev.events
  else if (Object.keys(events).length) doc.events = events
  fs.mkdirSync(entDir, { recursive: true })
  fs.writeFileSync(entFile, JSON.stringify(doc, null, 2) + '\n')
  console.log(
    `\nwrote ${entFile}` +
      `\n  id: ${id}  category: ${categoryArg}` +
      `\n  states: ${clipNames.join(', ')}` +
      (animFiles.length ? `\n  merge FBX at load: ${animFiles.join(', ')}` : '') +
      (Object.keys(emissive).length ? `\n  emissive parts: ${Object.keys(emissive).join(', ')}` : ''),
  )
}
generateEntityDoc()
