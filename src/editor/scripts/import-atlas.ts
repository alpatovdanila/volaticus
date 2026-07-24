// import-atlas.ts — import grid-atlas sprite animations (explosions etc.) as flipbook EFFECTS.
//
// The effect system plays flipbooks from INDIVIDUAL frame files (BurstSchema.flipbook:
// { pattern: "path/#.png", frames: N } — see src/inventory/effects.ts), so this slices each
// atlas into per-frame PNGs and generates a ready-to-preview effect doc per atlas:
//
//   resources/particle/explosions/"explosion 1.png"  (8×8 grid of 512² frames)
//     → resources/particle/explosions/explosion_1/0.png … N-1.png   (frames, resized)
//     → inventory/effects/explosion_1.json                          (single flipbook burst)
//
// Fully-transparent TRAILING frames are trimmed (grids are often padded); existing effect
// docs are kept unless --force (hand-tuning survives re-slicing).
//
//   npx tsx scripts/import-atlas.ts <file-or-folder> [--grid 8] [--fsize 256] [--life 0.9]
//                                   [--size 1.4] [--force]
//     file-or-folder  atlas PNG, or a folder of atlas PNGs (resources-relative or absolute)
//     --grid    frames per row/column (default 8 → 8×8 = 64 frames)
//     --fsize   output frame size in px (default 256 — plenty for particles)
//     --life    flipbook play time in seconds (default 0.9)
//     --size    sprite world size in meters (default 1.4)
//     --force   regenerate effect docs even if they exist
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RES = path.resolve(ROOT, 'resources')

const args = process.argv.slice(2)
let target = ''
let grid = 8
let fsize = 256
let life = 0.9
let size = 1.4
let force = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--grid') grid = parseInt(args[++i], 10) || 8
  else if (a === '--fsize') fsize = parseInt(args[++i], 10) || 256
  else if (a === '--life') life = parseFloat(args[++i]) || 0.9
  else if (a === '--size') size = parseFloat(args[++i]) || 1.4
  else if (a === '--force') force = true
  else if (!a.startsWith('--')) target = a
}
if (!target) throw new Error('usage: import-atlas.ts <file-or-folder> [--grid 8] [--fsize 256]')
const abs = path.isAbsolute(target) ? target : path.resolve(ROOT, target)

const atlases = fs.statSync(abs).isDirectory()
  ? fs.readdirSync(abs).filter((f) => /\.png$/i.test(f)).map((f) => path.join(abs, f))
  : [abs]
if (!atlases.length) throw new Error('no atlas PNGs found at ' + abs)

async function importAtlas(file: string): Promise<void> {
  const slug = path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const outDir = path.join(path.dirname(file), slug)
  const meta = await sharp(file).metadata()
  const cell = Math.floor((meta.width ?? 0) / grid)
  if (!cell || (meta.height ?? 0) < cell * grid) throw new Error(`${file}: not a ${grid}×${grid} grid`)

  // slice row-major; keep every frame, then TRIM the fully-transparent tail
  fs.mkdirSync(outDir, { recursive: true })
  const buffers: Buffer[] = []
  const alive: boolean[] = []
  for (let i = 0; i < grid * grid; i++) {
    const x = (i % grid) * cell
    const y = Math.floor(i / grid) * cell
    const img = sharp(file).extract({ left: x, top: y, width: cell, height: cell }).resize(fsize, fsize)
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
    let maxA = 0
    for (let p = 3; p < data.length; p += info.channels) maxA = Math.max(maxA, data[p])
    alive.push(maxA > 2)
    buffers.push(await img.png({ compressionLevel: 9 }).toBuffer())
  }
  let frames = grid * grid
  while (frames > 1 && !alive[frames - 1]) frames--
  for (let i = 0; i < frames; i++) fs.writeFileSync(path.join(outDir, `${i}.png`), buffers[i])
  // stale frames from a previous (longer) slice would break the flipbook contract — remove them
  for (const f of fs.readdirSync(outDir)) {
    const n = parseInt(f, 10)
    if (/^\d+\.png$/.test(f) && n >= frames) fs.unlinkSync(path.join(outDir, f))
  }

  const pattern = path.relative(RES, outDir).replace(/\\/g, '/') + '/#.png'
  console.log(`${slug}: ${frames} frames (${cell}px → ${fsize}px), trimmed ${grid * grid - frames} empty — ${pattern}`)

  // effect doc: ONE self-fading flipbook sprite at the origin (fade:false — the frames
  // already burn out; engine fade would double-fade). Tint white = authored colors.
  const effFile = path.resolve(ROOT, 'inventory', 'effects', `${slug}.json`)
  if (fs.existsSync(effFile) && !force) {
    console.log(`  effect ${slug}.json exists — kept (--force to regenerate)`)
    return
  }
  const doc = {
    format: 1,
    id: slug,
    name: slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    notes: `Imported via scripts/import-atlas.ts from ${path.relative(ROOT, file).replace(/\\/g, '/')} (${grid}×${grid} grid).`,
    particles: [
      {
        count: 1,
        size: [size, size],
        speed: [0, 0],
        life: [life, life],
        colors: ['#ffffff'],
        fade: false,
        flipbook: { pattern, frames },
      },
    ],
  }
  fs.mkdirSync(path.dirname(effFile), { recursive: true })
  fs.writeFileSync(effFile, JSON.stringify(doc, null, 2) + '\n')
  console.log(`  wrote inventory/effects/${slug}.json (life ${life}s, size ${size}m)`)
}

for (const a of atlases) await importAtlas(a)
