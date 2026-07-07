// One-off: apply the generic craft jitter across the inventory — organic things
// get wonky, buildings get subtly crooked, characters get a whisper of it.
import fs from 'node:fs'
import { stringifyPretty } from '../src/inventory/json'

type Doc = Record<string, any>
const SKIP_SHAPES = new Set(['plank', 'post', 'mesh', 'cross', 'plane'])

function walk(nodes: Doc, fn: (name: string, n: Doc) => void): void {
  for (const [name, n] of Object.entries<Doc>(nodes ?? {})) {
    fn(name, n)
    if (n.children) walk(n.children, fn)
  }
}

function craftify(file: string, rules: [RegExp, number][]): void {
  const d: Doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  let count = 0
  walk(d.rig, (name, n) => {
    if (!n.shape || SKIP_SHAPES.has(n.shape) || n.craft !== undefined) return
    for (const [re, craft] of rules) {
      if (re.test(name)) {
        n.craft = craft
        count++
        return
      }
    }
  })
  fs.writeFileSync(file, stringifyPretty(d))
  console.log(`craftified ${file} (${count} nodes)`)
}

craftify('inventory/props/chest.json', [
  [/^(floor|wall_|lid_lower|lid_upper)/, 0.8],
  [/strap/, 0.85],
])
craftify('inventory/props/geyser.json', [
  [/^(mound|vent)$/, 0.52],
  [/^stone_/, 0.55],
])
craftify('inventory/levelparts/house_family.json', [
  [/^walls$/, 0.9],
  [/^roof_/, 0.85],
  [/^chimney$/, 0.65],
  [/^doorstep$/, 0.7],
  [/^(post_|beam_)/, 0.75],
])
craftify('inventory/levelparts/house_admin.json', [
  [/^(base|upper)$/, 0.9],
  [/^roof_/, 0.85],
  [/^trim$/, 0.8],
  [/^step_/, 0.7],
])
craftify('inventory/levelparts/house_shop.json', [
  [/^walls$/, 0.9],
  [/^roof$/, 0.85],
  [/^chimney$/, 0.65],
  [/^pole_/, 0.7],
])
craftify('inventory/props/rock_small.json', [[/pebble/, 0.5]])
craftify('inventory/props/rock_big.json', [
  [/^moss/, 0.65],
  [/./, 0.5],
])
craftify('inventory/props/mushroom_small.json', [
  [/^(stem|baby)$/, 0.6],
  [/^cap_/, 0.65],
  [/^baby_cap$/, 0.65],
])
craftify('inventory/props/mushroom_big.json', [
  [/^stem$/, 0.6],
  [/^cap$/, 0.68],
  [/^gills$/, 0.7],
])
craftify('inventory/props/tree_oak.json', [
  [/^trunk$/, 0.6],
  [/^branch$/, 0.5],
  [/^(blob|shell)_/, 0.72],
])
craftify('inventory/props/tree_pine.json', [
  [/^trunk$/, 0.6],
  [/^(cone|spray)_/, 0.68],
])
craftify('inventory/props/tree_birch.json', [
  [/^trunk$/, 0.65],
  [/^branch$/, 0.55],
  [/^(blob|shell)_/, 0.72],
])
craftify('inventory/props/bush.json', [
  [/^stub_/, 0.6],
  [/^blob_/, 0.7],
])
craftify('inventory/props/bush_flowering.json', [[/^blob_/, 0.7]])
craftify('inventory/levelparts/ruins.json', [
  [/^moss_/, 0.65],
  [/./, 0.6],
])
craftify('inventory/props/wood_log.json', [[/^moss_/, 0.6]])
craftify('inventory/props/garden_bed_small.json', [[/^mound$/, 0.6]])
craftify('inventory/props/garden_bed_large.json', [
  [/^soil$/, 0.78],
  [/^ridge_/, 0.6],
])
craftify('inventory/enemies/boomba.json', [
  [/^body$/, 0.85],
  [/^(leg|foot)_/, 0.85],
  [/^fuse$/, 0.7],
])
craftify('inventory/enemies/rooket.json', [
  [/^body$/, 0.85],
  [/^(leg|foot)_/, 0.85],
])
craftify('inventory/characters/player.json', [
  [/^body_cube$/, 0.93],
  [/^body_ball$/, 0.9],
  [/^(mitt|boot)_/, 0.88],
  [/^(arm|leg)_[lr]_box$/, 0.92],
  [/^pack$/, 0.85],
])
