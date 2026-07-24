/*
 import-index.ts — one command for the CURRENT components format: a t-pose `index.glb` with no real
 animation, plus sibling `<Clip Name>.fbx` files.

   npx tsx scripts/import-index.ts bruno
   npx tsx scripts/import-index.ts bruno --maxtex 1024 --force
   npx tsx scripts/import-index.ts resources/models/bruno --anims "Walk Forward.fbx,Run Forward.fbx"

 It does four things:

   1. MERGE  every sibling FBX clip onto the GLB skeleton and inject them as real glTF
      animations, so the components is ONE file and ONE request at runtime. The retarget itself is
      src/inventory/fbx-anim-merge.ts — the same code the runtime loader uses, so a baked clip
      is identical to a merged one rather than a second implementation that can drift.

   2. DROP  any clip that is static (every track identical at every key). Exporters emit the
      bind pose as a 2-frame "animation"; carrying it through gives the entity a playable state
      that silently freezes the character. Detected by VALUE, never by name or duration.

   3. REPACK textures (optional, --maxtex N). Character exports routinely ship 2K/4K maps that
      dominate the file.

   4. GENERATE the entity doc at inventory/models/<id>/<id>.json — components.src pointing at the
      baked GLB (and NO components.anims, since the clips are inside it now), plus emissive controls
      for @exposeEmissive parts and dismemberable parts derived from skin weights. Clip names are
      not restated in the doc — they are readable from the GLB itself.

 The source index.glb is never modified: the bake always derives from it, so re-running is
 idempotent and can never double-bake.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import sharp from 'sharp'

import {
  readGlb,
  writeGlb,
  parseHeadless,
  findStaticClips,
  dropAnimations,
  injectClips,
  pruneOrphans,
  rebuildBin,
  toArrayBuffer,
  type Glb,
} from '../src/inventory/glb-container'
import { mergeFbxClips, type FbxAnimSource } from '../src/inventory/fbx-anim-merge'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/*
 Which meshes are offered as dismemberable. A severable part is a whole mesh node, so it has to
 be a limb-ish piece rigid to roughly one bone — the chunk is baked into its dominant bone's
 frame, and anything spanning the torso visibly snaps.

 The decisive test is WHICH bone owns the part, not what percentage it holds. A share cutoff
 alone splits symmetric pairs: bruno's right hand sits at 37% and its left at 26%, so any
 threshold between them offers one hand and not the other. Whether the dominant bone is a limb
 or a core bone is the property actually being asked about, and it is stable across a pair.

 This is a SUGGESTION keyed to mixamo naming, printed with its evidence — override with
 --dismember "a,b,c" when the heuristic guesses wrong on an unusual rig.
*/
const CORE_BONE = /(hips|spine|neck)\d*$/i // torso: severing these bisects the character
const DISMEMBER_MIN_DOMINANT_SHARE = 0.2
const DISMEMBER_MAX_BONES = 12
const DISMEMBER_MAX_VERTEX_SHARE = 0.35

const EXPOSE_EMISSIVE = /^(.+?)@exposeEmissive/
const DEFAULT_EMISSIVE = { color: '#66ccff', intensity: 2.5 }

interface PartInfo {
  key: string // the runtime name: three-sanitized, @exposeEmissive tag stripped
  emissive: boolean
  vertices: number
  dominantBone: string
  dominantShare: number
  bonesTouched: number
}

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
// a flag whose value is missing or is itself another flag is a typo, not an empty value —
// silently reading `--force` as the value of `--maxtex` skipped the repack the user asked for
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} needs a value`)
    process.exit(1)
  }
  return value
}
const has = (name: string) => argv.includes(`--${name}`)

const target = positional[0]
if (!target) {
  console.error(
    'usage: tsx scripts/import-index.ts <components-dir|name> [--id <id>] [--category <cat>]\n' +
      '                                  [--maxtex N] [--anims "a.fbx,b.fbx"] [--dismember "a,b"]\n' +
      '                                  [--out name.glb] [--force]',
  )
  process.exit(1)
}

const dir =
  target.includes('/') || target.includes('\\') || path.isAbsolute(target)
    ? path.resolve(ROOT, target)
    : path.join(ROOT, 'resources', 'models', target)

const source = path.join(dir, 'index.glb')
const outName = flag('out') ?? 'index.baked.glb'
const outFile = path.join(dir, outName)
const id = (flag('id') ?? path.basename(dir))
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_|_$/g, '')
const category = flag('category') ?? 'character'
const maxTex = flag('maxtex') ? Number(flag('maxtex')) : 0
const force = has('force')

// ---------------------------------------------------------------- steps

/*
 Skin weights say which bone actually owns a mesh. Mirrors the runtime's dominant-bone pick
 (src/inventory/effects.ts dominantBoneIndex): accumulate every non-zero weight per bone and
 take the argmax. The SHARE that bone holds is what tells us whether the part is rigid enough
 to sever cleanly.
*/
function analyseParts(scene: THREE.Object3D): PartInfo[] {
  const parts: PartInfo[] = []

  scene.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return

    // GLTFLoader has already sanitized the node name; strip the tag exactly as the runtime
    // does (src/inventory/factory.ts) so the key we write is the key it will look up.
    const tagged = EXPOSE_EMISSIVE.exec(mesh.name)
    const key = tagged ? tagged[1] : mesh.name

    const geometry = mesh.geometry
    const vertices = geometry.attributes.position?.count ?? 0
    const skinIndex = geometry.attributes.skinIndex
    const skinWeight = geometry.attributes.skinWeight

    if (!skinIndex || !skinWeight || !mesh.skeleton) {
      // rigid part: it moves as one thing by definition
      parts.push({ key, emissive: !!tagged, vertices, dominantBone: '(none)', dominantShare: 1, bonesTouched: 0 })
      return
    }

    const accumulated = new Map<number, number>()
    let total = 0
    for (let v = 0; v < skinIndex.count; v++) {
      for (let k = 0; k < 4; k++) {
        const weight = skinWeight.getComponent(v, k)
        if (weight <= 0) continue
        const bone = skinIndex.getComponent(v, k)
        accumulated.set(bone, (accumulated.get(bone) ?? 0) + weight)
        total += weight
      }
    }

    let bestBone = -1
    let best = 0
    for (const [bone, weight] of accumulated) if (weight > best) ((best = weight), (bestBone = bone))

    parts.push({
      key,
      emissive: !!tagged,
      vertices,
      dominantBone: mesh.skeleton.bones[bestBone]?.name ?? '(unknown)',
      dominantShare: total > 0 ? best / total : 0,
      bonesTouched: accumulated.size,
    })
  })

  return parts
}

function pickDismemberable(parts: PartInfo[], override: string[] | null): PartInfo[] {
  if (override) {
    const wanted = new Set(override)
    const picked = parts.filter((p) => wanted.has(p.key))
    for (const key of wanted)
      if (!picked.some((p) => p.key === key)) console.warn(`  ! --dismember "${key}" is not a part of this model`)
    return picked
  }

  const totalVertices = parts.reduce((sum, p) => sum + p.vertices, 0) || 1
  return parts.filter(
    (p) =>
      !CORE_BONE.test(p.dominantBone) &&
      p.dominantShare >= DISMEMBER_MIN_DOMINANT_SHARE &&
      p.bonesTouched <= DISMEMBER_MAX_BONES &&
      p.vertices / totalVertices <= DISMEMBER_MAX_VERTEX_SHARE,
  )
}

async function repackTextures(glb: Glb, cap: number): Promise<{ resized: number; saved: number }> {
  const images = glb.json.images ?? []
  const replaced = new Map<number, Buffer>()
  let saved = 0

  for (const image of images) {
    if (image.bufferView === undefined) continue // URI/data-URI images are not ours to touch
    const view = glb.json.bufferViews[image.bufferView]
    const src = glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)

    const meta = await sharp(src).metadata()
    const oversized = Math.max(meta.width ?? 0, meta.height ?? 0) > cap

    /*
     A PNG stays lossless forever if we only ever re-encode PNG->PNG, and on a character that is
     usually the metallicRoughness map — bruno's was 1.9 MB, 67% of the whole file, for data
     that is low-frequency and lossy-safe. Convert an OPAQUE png to jpeg; keep png only where
     alpha actually carries information (cutouts), since jpeg has none.
    */
    const toJpeg = (image.mimeType ?? 'image/png') === 'image/png' && !meta.hasAlpha
    if (!oversized && !toJpeg) continue

    let pipeline = sharp(src)
    if (oversized) pipeline = pipeline.resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true })

    const asJpeg = toJpeg || (image.mimeType ?? 'image/png') === 'image/jpeg'
    const encoded = asJpeg
      ? await pipeline.jpeg({ quality: 90 }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer()

    if (encoded.length >= src.length) continue // re-encoding made it worse; leave the original
    image.mimeType = asJpeg ? 'image/jpeg' : 'image/png' // keep the declared mime honest
    replaced.set(image.bufferView, encoded)
    saved += src.length - encoded.length
  }

  // rebuildBin also compacts, which reclaims the bytes orphaned by any dropped animation
  if (replaced.size) rebuildBin(glb, replaced)
  return { resized: replaced.size, saved }
}

function buildEntityDoc(
  previous: any,
  clipNames: string[],
  parts: PartInfo[],
  dismemberable: PartInfo[],
  srcPath: string,
): any {
  const model: any = { src: srcPath }

  // scale is required doc data the script cannot derive: carry the hand-tuned value, seed 1
  model.scale = previous?.model?.scale ?? 1

  // emissive: default for a newly seen part, but never clobber a tuned value
  const emissiveParts = parts.filter((p) => p.emissive)
  if (emissiveParts.length) {
    model.emissive = Object.fromEntries(
      emissiveParts.map((p) => [p.key, previous?.model?.emissive?.[p.key] ?? { ...DEFAULT_EMISSIVE }]),
    )
  }

  /*
   dismember: carry over a hand-tuned block when its keys still exist, otherwise seed from the
   skin-weight analysis. The filter compares against the SANITIZED runtime keys — comparing
   against raw glTF node names silently discards every correct key on a components whose nodes carry
   dots (e.g. "tripo_part_15.001" vs the runtime "tripo_part_15001").
  */
  const liveKeys = new Set(parts.map((p) => p.key))
  const carried = previous?.model?.dismember
    ? Object.fromEntries(Object.entries(previous.model.dismember).filter(([key]) => liveKeys.has(key)))
    : null
  if (carried && Object.keys(carried).length) model.dismember = carried
  else if (dismemberable.length) model.dismember = Object.fromEntries(dismemberable.map((p) => [p.key, { weight: 1 }]))

  /*
   Start from the previous doc so authored fields this script knows nothing about (tags,
   physics, props, per-state cues, …) survive a --force regen. Rebuilding the literal from a
   fixed whitelist silently deleted everything outside it — and since the script reported
   success, the loss was invisible.
  */
  const doc: any = {
    ...(previous ?? {}),
    format: 1,
    id,
    name: previous?.name ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
    category: previous?.category ?? category,
    model,
    materials: previous?.materials ?? {},
  }

  if (previous?.modifiers) doc.modifiers = previous.modifiers

  return doc
}

// ---------------------------------------------------------------- main

async function main() {
  if (!fs.existsSync(source)) throw new Error(`no index.glb at ${source}`)

  const animFiles = (
    flag('anims')
      ?.split(',')
      .map((s) => s.trim()) ?? fs.readdirSync(dir).filter((f) => /\.fbx$/i.test(f))
  ).sort()

  console.log(`source   ${path.relative(ROOT, source)}`)
  console.log(`anims    ${animFiles.length} file(s)`)

  const glb = readGlb(source)
  const { scene, animations } = await parseHeadless(glb, dir)

  // 1. drop static clips (by index — glTF animation names are optional and non-unique)
  const staticIndices = findStaticClips(animations)
  if (staticIndices.length) {
    const dropped = dropAnimations(glb, new Set(staticIndices))
    const names = staticIndices.map((i) => `"${animations[i].name}"`).join(', ')
    console.log(`dropped  ${dropped} static clip(s): ${names}  (frozen pose, not animation)`)
  }
  const kept = animations.filter((_, i) => !staticIndices.includes(i)).map((c) => c.name)

  // 2. merge the FBX clips
  const fbxLoader = new FBXLoader()
  const sources: FbxAnimSource[] = animFiles.map((file) => ({
    name: file.replace(/\.fbx$/i, ''),
    root: fbxLoader.parse(toArrayBuffer(fs.readFileSync(path.join(dir, file))), dir),
  }))
  const merged = mergeFbxClips(scene, sources)
  const stats = injectClips(glb, merged)
  for (const warning of stats.warnings) console.warn(`  ! ${warning}`)
  console.log(
    `merged   ${merged.length} clip(s), ${stats.tracks} tracks${stats.skipped ? `, ${stats.skipped} skipped` : ''}`,
  )

  // 3. repack
  if (maxTex > 0) {
    const { resized, saved } = await repackTextures(glb, maxTex)
    console.log(`repack   ${resized} texture(s) capped at ${maxTex}px, saved ${(saved / 1024 / 1024).toFixed(2)} MB`)
  }

  // 4. reclaim what the dropped clips left behind
  const pruned = pruneOrphans(glb)
  if (pruned.accessors || pruned.bufferViews) {
    console.log(`pruned   ${pruned.accessors} orphan accessor(s), ${pruned.bufferViews} bufferView(s)`)
  }

  writeGlb(outFile, glb)

  // 5. entity doc
  const parts = analyseParts(scene)
  const dismemberable = pickDismemberable(
    parts,
    flag('dismember')
      ?.split(',')
      .map((s) => s.trim()) ?? null,
  )
  // from what injectClips ACTUALLY wrote: a clip whose tracks all failed node lookup is not
  // in the file, and naming it in states/locomotion would dangle
  const clipNames = [...kept, ...stats.written]

  console.log('\nparts')
  const totalVertices = parts.reduce((sum, p) => sum + p.vertices, 0) || 1
  for (const p of parts) {
    const marks = [dismemberable.includes(p) ? 'dismember' : '', p.emissive ? 'emissive' : '']
      .filter(Boolean)
      .join(' + ')
    console.log(
      `  ${p.key.padEnd(22)} ${String(p.vertices).padStart(6)}v  ` +
        `${(p.dominantShare * 100).toFixed(0).padStart(3)}% ${p.dominantBone.padEnd(24)} ` +
        `${String(p.bonesTouched).padStart(2)} bones  ${(((p.vertices / totalVertices) * 100) | 0).toString().padStart(2)}%  ${marks}`,
    )
  }

  const docPath = path.join(ROOT, 'inventory', 'entities', id, `${id}.json`)
  const exists = fs.existsSync(docPath)
  const previous = exists ? JSON.parse(fs.readFileSync(docPath, 'utf8')) : null

  if (exists && !force) {
    console.log(`\ndoc      ${path.relative(ROOT, docPath)} exists — left alone (pass --force to regenerate)`)
  } else {
    const srcPath = `models/${path.basename(dir)}/${outName}`
    const doc = buildEntityDoc(previous, clipNames, parts, dismemberable, srcPath)
    fs.mkdirSync(path.dirname(docPath), { recursive: true })
    fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + '\n')
    console.log(`\ndoc      ${path.relative(ROOT, docPath)}`)
    console.log(`         dismember:  ${doc.model.dismember ? Object.keys(doc.model.dismember).join(', ') : '(none)'}`)
    console.log(`         emissive:   ${doc.model.emissive ? Object.keys(doc.model.emissive).join(', ') : '(none)'}`)
  }

  const size = (n: number) => (n / 1024 / 1024).toFixed(2) + ' MB'
  console.log(`\nwrote    ${path.relative(ROOT, outFile)}`)
  console.log(`         ${clipNames.length} animation(s): ${clipNames.join(', ')}`)
  console.log(`         ${size(fs.statSync(source).size)} -> ${size(fs.statSync(outFile).size)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
