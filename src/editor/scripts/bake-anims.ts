/*
 Bake sibling Mixamo FBX clips into a GLB, so a components is ONE file and ONE request at runtime
 instead of index.glb + N .fbx.

   npx tsx scripts/bake-anims.ts resources/models/marine2
   npx tsx scripts/bake-anims.ts resources/models/marine2 --out index.baked.glb
   npx tsx scripts/bake-anims.ts resources/models/marine2 --anims "Rifle Walk.fbx,Rifle Run.fbx"

 This is the ANIMATION-ONLY tool. For a full import — bake + texture repack + entity doc with
 emissive/dismember/locomotion — use scripts/import-index.ts, which wraps the same steps.

 The clips are produced by src/inventory/fbx-anim-merge.ts and the container is edited by
 src/inventory/glb-container.ts, both shared with the runtime loader and the importer, so
 baking changes WHEN the work happens rather than what it produces.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'

import { readGlb, writeGlb, parseHeadless, injectClips, toArrayBuffer } from '../src/inventory/glb-container'
import { mergeFbxClips, type FbxAnimSource } from '../src/inventory/fbx-anim-merge'

async function main() {
  const argv = process.argv.slice(2)
  const positional = argv.filter((a) => !a.startsWith('--'))
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }

  const target = positional[0]
  if (!target) {
    console.error(
      'usage: tsx scripts/bake-anims.ts <components-dir|index.glb> [--out name.glb] [--anims "a.fbx,b.fbx"]',
    )
    process.exit(1)
  }

  const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory()
  const source = isDir ? path.join(target, 'index.glb') : target
  const dir = path.dirname(source)
  if (!fs.existsSync(source)) throw new Error(`no GLB at ${source}`)

  const animFiles = (
    flag('anims')
      ?.split(',')
      .map((s) => s.trim()) ?? fs.readdirSync(dir).filter((f) => /\.fbx$/i.test(f))
  ).sort()
  if (!animFiles.length) throw new Error(`no .fbx animations beside ${source}`)

  const outFile = path.join(dir, flag('out') ?? 'index.baked.glb')

  console.log(`source  ${source}`)
  console.log(`anims   ${animFiles.length} file(s)`)

  const glb = readGlb(source)
  const { scene } = await parseHeadless(glb, dir)

  const fbxLoader = new FBXLoader()
  const sources: FbxAnimSource[] = animFiles.map((file) => ({
    name: file.replace(/\.fbx$/i, ''),
    root: fbxLoader.parse(toArrayBuffer(fs.readFileSync(path.join(dir, file))), dir),
  }))

  const clips = mergeFbxClips(scene, sources)
  console.log(`merged  ${clips.length} clip(s)`)

  const before = glb.json.animations?.length ?? 0
  const stats = injectClips(glb, clips)
  for (const warning of stats.warnings) console.warn(`  ! ${warning}`)
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
