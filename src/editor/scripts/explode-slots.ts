// Item 34 migration: exploded slots + persisted inheritance.
// For every entity, each material slot referenced by MORE THAN ONE (node, face)
// pair — several nodes, or several faces of one node — becomes a GROUP PARENT:
// every reference gets its own child slot containing ONLY
// { "inherit": "<origSlot>" }, and the reference is rewritten to the child.
// Naming: a whole-node (string) reference mints <node>; a face-map reference
// mints <node>_<face> (spec: per-face maps explode per face where the face slot
// was shared, so any two faces can later diverge without hand-editing JSON).
// Collisions → suffix _2, _3, …. The parent keeps all its values (it may end up
// referenced by no geometry — that's the group knob). Slots referenced exactly
// once stay untouched, so the script is idempotent (after a run every slot has
// at most one reference; re-runs change nothing).
//
// Pixel-identity self-check: after rewriting, resolveMaterials() on the new
// materials must yield, for every rewritten reference, EXACTLY the values the
// original slot carried — the render resolves to the same material params.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyPretty } from '../src/inventory/json'
import { resolveMaterials, type MaterialDef } from '../src/inventory/schema'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INV = path.join(ROOT, 'inventory')
const ENTITY_DIRS = ['props', 'pickups', 'enemies', 'characters', 'levelparts']

type Doc = Record<string, any>
type FaceMap = Record<string, string>

function walkRig(nodes: Doc, fn: (name: string, n: Doc) => void): void {
  for (const [name, n] of Object.entries<Doc>(nodes ?? {})) {
    fn(name, n)
    if (n.children) walkRig(n.children, fn)
  }
}

// canonical JSON (sorted keys) for deep-equality of resolved defs
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  return (
    '{' +
    Object.keys(v as Doc)
      .sort()
      .filter((k) => (v as Doc)[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canon((v as Doc)[k]))
      .join(',') +
    '}'
  )
}

interface Stat {
  file: string
  before: number
  after: number
  exploded: { parent: string; children: string[] }[]
}

function migrate(file: string): Stat | null {
  const d: Doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const materials: Record<string, MaterialDef> = d.materials ?? {}
  const before = Object.keys(materials).length

  // 1) count references per slot as (node, face) PAIRS — a string material is
  // one pair, each face-map entry is one pair. A slot is SHARED when >1 pair
  // references it (several nodes, or several faces of one node).
  const refCount = new Map<string, number>()
  const bump = (slot: string) => refCount.set(slot, (refCount.get(slot) ?? 0) + 1)
  walkRig(d.rig ?? {}, (_name, n) => {
    if (!n.material) return
    if (typeof n.material === 'string') bump(n.material)
    else for (const slot of Object.values(n.material as FaceMap)) bump(slot)
  })

  // 2) shared slots → explode
  const shared = new Set([...refCount.entries()].filter(([, c]) => c > 1).map(([slot]) => slot))
  if (!shared.size) return null

  // resolved view of the ORIGINAL materials (self-check reference)
  const originalResolved = resolveMaterials(materials)

  // 3) per shared reference: mint a child slot { inherit: parent } and rewrite
  // the reference — <node> for whole-node refs, <node>_<face> per face-map face.
  const childrenOf = new Map<string, { name: string; def: MaterialDef }[]>() // parent → children, in creation order
  const taken = new Set(Object.keys(materials))
  const mintChild = (baseName: string, parent: string): string => {
    let name = baseName
    for (let i = 2; taken.has(name); i++) name = `${baseName}_${i}`
    taken.add(name)
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent)!.push({ name, def: { inherit: parent } })
    return name
  }
  const rewrites: { child: string; parent: string }[] = []
  walkRig(d.rig ?? {}, (name, n) => {
    if (!n.material) return
    if (typeof n.material === 'string') {
      if (!shared.has(n.material)) return
      const child = mintChild(name, n.material)
      rewrites.push({ child, parent: n.material })
      n.material = child
    } else {
      const m = n.material as FaceMap
      for (const face of Object.keys(m)) {
        const slot = m[face]
        if (!shared.has(slot)) continue
        const child = mintChild(`${name}_${face}`, slot)
        rewrites.push({ child, parent: slot })
        m[face] = child
      }
    }
  })

  // 4) rebuild the materials record with children inserted right after their parent
  const next: Record<string, MaterialDef> = {}
  for (const [slot, def] of Object.entries(materials)) {
    next[slot] = def
    for (const c of childrenOf.get(slot) ?? []) next[c.name] = c.def
  }
  d.materials = next

  // 5) SELF-CHECK: every child resolves to exactly what its parent slot carried
  const resolved = resolveMaterials(next)
  for (const { child, parent } of rewrites) {
    const want = canon(originalResolved[parent])
    const got = canon(resolved[child])
    if (want !== got)
      throw new Error(`${file}: child "${child}" resolves to ${got}, expected parent "${parent}" values ${want}`)
  }

  fs.writeFileSync(file, stringifyPretty(d))
  return {
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    before,
    after: Object.keys(next).length,
    exploded: [...childrenOf.entries()].map(([parent, kids]) => ({ parent, children: kids.map((k) => k.name) })),
  }
}

let touched = 0
let unchanged = 0
for (const dir of ENTITY_DIRS) {
  const abs = path.join(INV, dir)
  if (!fs.existsSync(abs)) continue
  for (const f of fs.readdirSync(abs).filter((f) => f.endsWith('.json')).sort()) {
    const stat = migrate(path.join(abs, f))
    if (!stat) {
      unchanged++
      continue
    }
    touched++
    console.log(`${stat.file}: ${stat.before} → ${stat.after} slots`)
    for (const e of stat.exploded) console.log(`    ${e.parent} → ${e.children.join(', ')}`)
  }
}
console.log(`\n${touched} entities exploded, ${unchanged} already flat/single-referenced`)
