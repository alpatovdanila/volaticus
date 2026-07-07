// One-off: convert plain boxes/cylinders to procedural plank/post shapes in the
// wood props, with per-item craftsmanship values.
import fs from 'node:fs'
import { stringifyPretty } from '../src/inventory/json'

type Doc = Record<string, any>
const load = (f: string): Doc => JSON.parse(fs.readFileSync(f, 'utf8'))
const save = (f: string, d: Doc) => {
  fs.writeFileSync(f, stringifyPretty(d))
  console.log('swapped', f)
}
const walk = (nodes: Doc, fn: (name: string, n: Doc) => void) => {
  for (const [name, n] of Object.entries<Doc>(nodes ?? {})) {
    fn(name, n)
    if (n.children) walk(n.children, fn)
  }
}
const toPlank = (n: Doc, craft: number) => {
  n.shape = 'plank'
  n.craft = craft
  delete n.segments
}
const toPost = (n: Doc, craft: number) => {
  n.shape = 'post'
  n.craft = craft
}

{
  const f = 'inventory/props/wooden_fence.json'
  const d = load(f)
  walk(d.rig, (_name, n) => {
    if (n.shape === 'cylinder') toPost(n, 0.35)
    if (n.shape === 'box') toPlank(n, 0.35)
  })
  save(f, d)
}
{
  const f = 'inventory/props/wooden_bench.json'
  const d = load(f)
  walk(d.rig, (_name, n) => {
    if (n.shape === 'box') toPlank(n, 0.55)
  })
  save(f, d)
}
{
  const f = 'inventory/props/crate.json'
  const d = load(f)
  walk(d.rig, (name, n) => {
    if (n.shape === 'box' && (name.startsWith('post_') || name.startsWith('rail_') || name.startsWith('brace_')))
      toPlank(n, 0.5)
    if (n.shape === 'box' && name === 'panel') toPlank(n, 0.8)
  })
  save(f, d)
}
{
  const f = 'inventory/props/road_sign.json'
  const d = load(f)
  walk(d.rig, (_name, n) => {
    if (n.shape === 'cylinder') toPost(n, 0.4)
    if (n.shape === 'box') toPlank(n, 0.4)
  })
  save(f, d)
}
for (const f of ['inventory/props/garden_bed_small.json', 'inventory/props/garden_bed_large.json']) {
  const d = load(f)
  walk(d.rig, (name, n) => {
    if (n.shape === 'box' && (name.startsWith('rail_') || name.startsWith('post_'))) toPlank(n, 0.55)
  })
  save(f, d)
}
{
  const f = 'inventory/props/wood_log.json'
  const d = load(f)
  walk(d.rig, (name, n) => {
    if (n.shape === 'cylinder' && (name === 'trunk' || name === 'stub')) toPost(n, 0.3)
  })
  save(f, d)
}
{
  const f = 'inventory/props/well.json'
  const d = load(f)
  walk(d.rig, (name, n) => {
    if (n.shape === 'box' && (name.startsWith('post_') || name === 'ridge')) toPlank(n, 0.5)
    if (n.shape === 'box' && name.startsWith('roof_')) toPlank(n, 0.7)
  })
  save(f, d)
}
