// The inventory format spec. Pure zod + helpers — imported by the browser editor,
// the game runtime, and the node-side validate script alike. Keep it framework-free.
import { z } from 'zod'

// ---------------------------------------------------------------------------
// shared bits

const vec3 = z.tuple([z.number(), z.number(), z.number()])
const vec2 = z.tuple([z.number(), z.number()])
const range = z.tuple([z.number(), z.number()])
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb')

export const FACE_KEYS = ['all', 'side', 'top', 'bottom', 'front', 'back', 'left', 'right'] as const
export type FaceKey = (typeof FACE_KEYS)[number]

// ---------------------------------------------------------------------------
// entity

// named surface preset (declared in inventory/settings.json "surfaces"):
// roughness/metalness plus env = environment-reflection intensity. Materials
// without a preset get env 0 — fully predictable, light-only shading.
export const SurfaceSchema = z.object({
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  env: z.number().min(0).max(2).optional(),
})
export type SurfaceDef = z.infer<typeof SurfaceSchema>

// Entity material slot (post-migration): references a named PBR catalog material
// and carries only GEOMETRIC/placement overrides. The PBR maps + roughness/metal/
// normal/ao/height + opacity/cutout/doubleSided all come from the catalog `tuning`.
// The legacy per-slot texture/surface/opacity/cutout/etc. keys are retired.
export const MaterialSchema = z.object({
  // catalog material id (inventory/materials/<id>.json). Required unless the
  // slot inherits — then the inherit CHAIN must terminate in a slot that has one.
  material: z.string().min(1).optional(),
  // item 34: parent slot name. Every key UNSET on this slot resolves from the
  // parent, recursively (chains allowed; cycles are a validation error). Own
  // keys are overrides; deleting an override falls back to the live parent
  // value. Parent slots referenced by no geometry are legal group knobs.
  inherit: z.string().min(1).optional(),
  // NOTE: no tinting — a material renders exactly as its texture (distinct colors come
  // from distinct catalog materials). No `flat` either — shading is a GLOBAL artistic
  // choice (Light panel "flat
  // shading"); v8 bakes carry crease-welded smooth normals on every shape.
  // render both faces for this slot (overrides catalog tuning.doubleSided). Needed
  // by open shells (barrel body) so the far interior wall isn't backface-culled;
  // kept per-slot so a shared catalog material stays single-sided on solid props.
  doubleSided: z.boolean().optional(),
  // Per-AXIS tiling mode. A single value applies to both axes; a space-separated pair is
  // "U V" (texture axes, pre-uvRot) — e.g. "fit stretch" = whole repeats horizontally,
  // exactly once vertically. Modes:
  //   tile (default): uvScale repeats per meter — for seamless textures.
  //   fit: whole repeats over the face extent — patterns never cut mid-motif; on a closed
  //        surface's wrap axis (a barrel side's circumference) it kills the wrap seam.
  //   stretch: the texture exactly once over the face — one-shot motifs (lids, doors, signs).
  uvMode: z
    .enum([
      'tile',
      'fit',
      'stretch',
      'tile fit',
      'tile stretch',
      'fit tile',
      'fit stretch',
      'stretch tile',
      'stretch fit',
    ])
    .optional(),
  uvScale: z.number().positive().optional(), // density: repeats per meter in tile/fit modes (default 1)
  uvRot: z.number().min(0).max(359).optional(), // texture direction, degrees CCW (UI offers 15° steps)
  // UV projection for the geometry using this slot (box | planar | sphere), applied
  // in entity space after jitter — THE single source for projection (resolved through
  // the slot inherit chain; it is no longer a rig/node concern). 'none' = EXPLICIT
  // "keep authored/tiled UVs" (persistable, so an inheriting child can pin
  // no-projection over a projecting parent). Absent = no projection (or defer to parent).
  uvProject: z.enum(['box', 'planar', 'sphere', 'none']).optional(),
})
export type MaterialDef = z.infer<typeof MaterialSchema>

// A slot after inheritance resolution: every value merged down the inherit
// chain (child keys override parent), no `inherit` key left. `material` is
// present on any VALID doc (validation guarantees each chain terminates in a
// slot that has one) — it stays optional here so invalid docs still render
// (makeSlotMaterial falls back to magenta).
export type ResolvedMaterialDef = Omit<MaterialDef, 'inherit'>

// THE single inheritance resolver (item 34) — every consumer (factory, effects/
// preview, editor chips, game + level builds) reads slots through this. For each
// slot, walk the inherit chain parent-ward, keeping the nearest (most-derived)
// value of each key. Cycles/dangling targets just stop the walk — validation
// reports them; the resolver stays total so live editing never throws.
export function resolveMaterials(materials: Record<string, MaterialDef>): Record<string, ResolvedMaterialDef> {
  const out: Record<string, ResolvedMaterialDef> = {}
  for (const slot of Object.keys(materials)) {
    const merged: Record<string, unknown> = {}
    const seen = new Set<string>()
    let cur: string | undefined = slot
    while (cur !== undefined && materials[cur] && !seen.has(cur)) {
      seen.add(cur)
      const def = materials[cur] as Record<string, unknown>
      for (const [k, v] of Object.entries(def)) if (k !== 'inherit' && v !== undefined && !(k in merged)) merged[k] = v
      cur = materials[cur].inherit
    }
    out[slot] = merged as ResolvedMaterialDef
  }
  return out
}

// Inheritance-graph validation used by validateEntity: target exists, no
// cycles, every chain terminates in a slot carrying `material`.
function checkSlotInheritance(materials: Record<string, MaterialDef>, issues: string[]): void {
  for (const [slot, def] of Object.entries(materials)) {
    if (def.inherit !== undefined && !materials[def.inherit])
      issues.push(`materials.${slot}: unknown inherit target "${def.inherit}"`)
    if (def.material === undefined && def.inherit === undefined) {
      issues.push(`materials.${slot}: slot has neither "material" nor "inherit"`)
      continue
    }
    // walk the FULL chain — resolution (resolveMaterials) merges past slots
    // that carry `material`, so a cycle ANYWHERE in the chain is an error even
    // when every slot in it has its own material. Termination = some slot in
    // the chain carries `material`. A dangling target already got its own
    // issue above — don't double-report.
    const seen = new Set<string>()
    let hasMaterial = false
    let cur: string | undefined = slot
    while (cur !== undefined) {
      if (seen.has(cur)) {
        issues.push(`materials.${slot}: inherit cycle (${[...seen].join(' → ')} → ${cur})`)
        break
      }
      const def2: MaterialDef | undefined = materials[cur]
      if (!def2) break // dangling target — reported for its owning slot
      seen.add(cur)
      if (def2.material !== undefined) hasMaterial = true
      if (def2.inherit === undefined) {
        if (!hasMaterial) issues.push(`materials.${slot}: inherit chain never reaches a slot with "material"`)
        break
      }
      cur = def2.inherit
    }
  }
}

const faceMaterial = z.union([
  z.string(),
  z.object({
    all: z.string().optional(),
    side: z.string().optional(),
    top: z.string().optional(),
    bottom: z.string().optional(),
    front: z.string().optional(),
    back: z.string().optional(),
    left: z.string().optional(),
    right: z.string().optional(),
  }),
])

// a boolean modifier: a generated shape (same params as a node, geometry-only) placed
// relative to the OWNER node's local space, combined into it at bake time (CSG)
export type BooleanMod = {
  op: 'subtract' | 'union' | 'intersect'
  shape:
    | 'box'
    | 'cylinder'
    | 'sphere'
    | 'capsule'
    | 'cone'
    | 'torus'
    | 'halfSphere'
    | 'quarterSphere'
    | 'halfCylinder'
    | 'arch'
    | 'halfTorus'
    | 'quarterTorus'
  size?: number[]
  radius?: number
  radiusTop?: number
  radiusBottom?: number
  height?: number
  tube?: number
  thickness?: number
  segments?: number
  segmentsY?: number
  bulge?: number
  pos?: [number, number, number]
  rot?: [number, number, number]
  scale?: number | [number, number, number]
}

export type NodeDef = {
  shape?:
    | 'box'
    | 'cylinder'
    | 'sphere'
    | 'capsule'
    | 'cone'
    | 'plane'
    | 'disk'
    | 'cross'
    | 'torus'
    | 'mesh'
    | 'plank'
    | 'post'
    | 'ring'
    | 'arrow'
    | 'star'
    | 'decal'
    | 'halfSphere'
    | 'quarterSphere'
    | 'halfCylinder'
    | 'arch'
    | 'halfTorus'
    | 'quarterTorus'
    | 'tree'
  mesh?: string
  image?: string
  craft?: number
  sub?: number
  size?: number[]
  radius?: number
  radiusTop?: number
  radiusBottom?: number
  height?: number
  tube?: number
  thickness?: number
  tip?: number
  points?: number
  innerRatio?: number
  depth?: number
  segments?: number
  segmentsY?: number
  open?: boolean
  bulge?: number
  arc?: number
  lushness?: number
  spread?: number
  leafSize?: number
  doubleWall?: boolean
  booleans?: BooleanMod[]
  pos?: [number, number, number]
  rot?: [number, number, number]
  scale?: number | [number, number, number]
  pivot?: [number, number, number]
  material?: z.infer<typeof faceMaterial>
  hidden?: boolean
  chance?: number
  rotJitter?: [number, number, number]
  craftSeed?: number
  children?: Record<string, NodeDef>
}

// boolean modifiers (CSG at bake): geometry-only shape defs — no children, no material
// (the cut inherits the owner node's single slot), no craft/sub of their own.
export const BooleanModSchema = z.object({
  op: z.enum(['subtract', 'union', 'intersect']),
  shape: z.enum([
    'box',
    'cylinder',
    'sphere',
    'capsule',
    'cone',
    'torus',
    'halfSphere',
    'quarterSphere',
    'halfCylinder',
    'arch',
    'halfTorus',
    'quarterTorus',
  ]),
  size: z.array(z.number().positive()).min(2).max(3).optional(),
  radius: z.number().positive().optional(),
  radiusTop: z.number().positive().optional(),
  radiusBottom: z.number().positive().optional(),
  height: z.number().positive().optional(),
  tube: z.number().positive().optional(),
  thickness: z.number().positive().optional(),
  segments: z.number().int().min(3).max(32).optional(),
  segmentsY: z.number().int().min(2).max(32).optional(),
  bulge: z.number().optional(),
  pos: vec3.optional(),
  rot: vec3.optional(),
  scale: z.union([z.number().positive(), vec3]).optional(),
})

export const NodeSchema: z.ZodType<NodeDef> = z.lazy(() =>
  z.object({
    shape: z
      .enum([
        'box',
        'cylinder',
        'sphere',
        'capsule',
        'cone',
        'plane',
        'disk',
        'cross',
        'torus',
        'mesh',
        'plank',
        'post',
        'ring',
        'arrow',
        'star',
        'decal',
        'halfSphere',
        'quarterSphere',
        'halfCylinder',
        'arch',
        'halfTorus',
        'quarterTorus',
        'tree',
      ])
      .optional(),
    mesh: z.string().optional(), // external model path relative to resources/ (fbx)
    // shape "decal" ONLY: the sprite itself, EMBEDDED as a base64 data URI (data:image/png;base64,…)
    // — the entity JSON stays a full self-contained declaration, no sidecar files. A decal is a flat
    // w×h quad (size, meters, facing +Z pre-rot) carrying this image once (0..1 UVs, never tiled),
    // alpha-cutout, no material slot. Author it as a CHILD of the part it sits on, offset ~1-2 mm
    // along the surface normal so it can't z-fight (eyes, faces, labels, little painted details).
    image: z.string().optional(),
    craft: z.number().min(0).max(1).optional(), // craftsmanship: 1 = machine-perfect, 0 = crooked (any shape)
    sub: z.number().int().min(0).max(4).optional(), // subdivision world before craft jitter (4^n triangles)
    size: z.array(z.number().positive()).min(2).max(3).optional(),
    radius: z.number().positive().optional(),
    radiusTop: z.number().positive().optional(), // cylinder frustum (defaults to radius)
    radiusBottom: z.number().positive().optional(),
    height: z.number().positive().optional(),
    tube: z.number().positive().optional(), // torus ring thickness (tube radius)
    thickness: z.number().positive().optional(), // ring wall thickness (inner radius = outer - thickness)
    tip: z.number().positive().optional(), // arrow ONLY: point length in meters (default min(h*0.9, w*0.45))
    points: z.number().int().min(3).max(12).optional(), // star ONLY: point count (default 5)
    innerRatio: z.number().min(0.1).max(0.9).optional(), // star ONLY: inner/outer radius ratio (default 0.45)
    depth: z.number().positive().optional(), // star ONLY: extrusion depth (default radius*0.35)
    segments: z.number().int().min(3).max(32).optional(), // cylinder/cone radial segments (4 + rot 45 = pyramid)
    segmentsY: z.number().int().min(2).max(32).optional(), // sphere ONLY: vertical rows (default segments/2)
    open: z.boolean().optional(), // cylinder/halfCylinder without end caps (hollow tube / open trough)
    bulge: z.number().optional(), // cylinder ONLY: barrel-belly, +meters of radius at mid-height (0 at rims)
    // arch/halfTorus/quarterTorus: sweep angle in degrees (default 180 / 180 / 90) —
    // lets an arch stop short or a torus segment wrap further without new shapes
    arc: z.number().min(10).max(360).optional(),
    // shape "tree" (recursive trunk/branch/twig generator + leaf blobs, seeded by
    // craftSeed): height + radius set the trunk; the rest shape the species.
    lushness: z.number().min(0).max(1).optional(), // branch counts + twig recursion (birch high)
    spread: z.number().min(10).max(85).optional(), // branch angle from vertical, deg (oak wide)
    leafSize: z.number().min(0).max(2).optional(), // terminal blob radius (0 = bare)
    // half/quarter sphere + halfCylinder: wall thickness in meters. Absent = solid
    // (flat caps close the shape); present = hollow shell with rim faces.
    // (`thickness` is shared with shape "ring" — same meaning there.)
    booleans: z.array(BooleanModSchema).optional(),
    // BAKE the back-faces in as real geometry (duplicate triangles, reversed winding + flipped
    // normals) so an open/thin surface reads from BOTH sides with a SINGLE-SIDED material — which
    // then merges with the part's other single-sided same-material parts (one fewer draw). Trades
    // 2× the part's triangles (cheap — GPU is idle) for one fewer draw ritual (the real cost).
    // Pair with a single-sided slot: setting BOTH this and material doubleSided just double-pays.
    doubleWall: z.boolean().optional(),
    pos: vec3.optional(),
    rot: vec3.optional(),
    scale: z.union([z.number().positive(), vec3]).optional(),
    pivot: vec3.optional(),
    material: faceMaterial.optional(),
    hidden: z.boolean().optional(),
    chance: z.number().min(0).max(1).optional(),
    rotJitter: vec3.optional(), // random rotation, ± degrees per axis — rolled per variant into <id>.variants.json
    craftSeed: z.number().int().optional(), // stored per-part craft-jitter seed (studio-written); seam-group members share one
    children: z.record(NodeSchema).optional(),
  }),
)

// effect reference: plain id, or parameterized — bursts marked "inherit" in the
// effect take the caller's texture (e.g. wood_break debris matching the barrel)
const effectRef = z.union([
  z.string(),
  z.object({
    id: z.string(),
    texture: z.string().optional(),
    uvRot: z.number().min(0).max(359).optional(), // degrees (UI offers 15° steps)
    slot: z.string().optional(), // inherit texture+uvRot from this material slot (stays in sync)
    part: z.string().optional(), // SCRIPT_EFFECT_DISMEMBER: name of the mesh part to sever + throw
    // seconds to hold the effect AND the binding's modifier flip (the "consequence") after the
    // binding fires — the binding's anim/sfx start immediately, so a flinch can lead before the
    // visible detach (e.g. dismember at 0.25s into the hit reaction).
    delay: z.number().min(0).optional(),
  }),
])
export type EffectRef = z.infer<typeof effectRef>

export function effectIdOf(e: EffectRef | undefined): string | undefined {
  return typeof e === 'string' ? e : e?.id
}

export function effectParamsOf(e: EffectRef | undefined): { texture?: string; uvRot?: number } {
  return typeof e === 'object' && e ? { texture: e.texture, uvRot: e.uvRot } : {}
}

// Reserved "script effect" ids referenced from a binding's `effect` field instead
// of an inventory effect — built-in runtime behaviors the studio/game resolve
// directly (preview.ts) rather than looking up inventory/effects/. Exempt from the
// effect-existence cross-check. SCRIPT_EFFECT_SHATTER = throw the entity's parts apart;
// SCRIPT_EFFECT_DISMEMBER = sever + throw ONE named mesh part (effect.part), e.g. a hand.
export const SCRIPT_EFFECTS = ['SCRIPT_EFFECT_SHATTER', 'SCRIPT_EFFECT_DISMEMBER'] as const
export type ScriptEffect = (typeof SCRIPT_EFFECTS)[number]
export function isScriptEffect(id: string | undefined): id is ScriptEffect {
  return !!id && (SCRIPT_EFFECTS as readonly string[]).includes(id)
}

const bindingCore = {
  sfx: z.string().optional(),
  effect: effectRef.optional(), // an inventory effect id, or a reserved SCRIPT_EFFECT_* (e.g. shatter)
  anim: z.string().optional(), // one-shot overlay clip (hit wobble etc.); state anim resumes after
  // hide the entity's MAIN geometry as part of a reaction (so only the effect/debris
  // shows). NOT instance removal — the runtime decides whether/when to despawn.
  hideGeometry: z.boolean().optional(),
  // activate an entity-level MODIFIER as part of the reaction (e.g. dismember → the
  // "dismembered" modifier hides the severed part across ALL later states). '' clears.
  modifier: z.string().optional(),
}

export const BindingSchema = z.object({
  ...bindingCore,
  // context-conditional overrides, keyed "dimension=value" (e.g. "surface=grass").
  // The game sets context at runtime (ground material etc.); matching entries
  // merge over the base binding in order. The editor offers preview dropdowns.
  byContext: z.record(z.object(bindingCore)).optional(),
})
export type Binding = z.infer<typeof BindingSchema>

const CONTEXT_KEY_RE = /^[a-z0-9_]+=[a-z0-9_]+$/

export function resolveBinding(b: Binding, context: Record<string, string>): Binding {
  if (!b.byContext) return b
  let out: Binding = { ...b }
  for (const [key, override] of Object.entries(b.byContext)) {
    const [dim, value] = key.split('=')
    if (context[dim] === value) out = { ...out, ...override }
  }
  return out
}

// which context dimensions/values an entity's bindings mention — drives the editor's preview dropdowns
export function contextDimsOf(doc: EntityDoc): Map<string, Set<string>> {
  const dims = new Map<string, Set<string>>()
  const scan = (b: unknown) => {
    const bc = (b as Binding | undefined)?.byContext
    for (const key of Object.keys(bc ?? {})) {
      const [dim, value] = key.split('=')
      if (!dims.has(dim)) dims.set(dim, new Set())
      dims.get(dim)!.add(value)
    }
  }
  for (const [key, val] of Object.entries(doc.states ?? {})) {
    if (key === 'initial') continue
    const s = val as StateDef
    scan(s.enter)
    for (const b of Object.values(s.cues ?? {})) scan(b)
  }
  for (const b of Object.values(doc.events ?? {})) scan(b)
  return dims
}

// entity-level face/appearance modifier: extra show/hide applied ON TOP of the
// current state's visibility (reapplied after every state change). Orthogonal
// to states — a "happy" face combines with walking, jumping, anything.
export const ModifierSchema = z.object({
  show: z.array(z.string()).optional(),
  hide: z.array(z.string()).optional(),
})
export type ModifierDef = z.infer<typeof ModifierSchema>

export const StateSchema = z.object({
  anim: z.string().optional(),
  show: z.array(z.string()).optional(),
  hide: z.array(z.string()).optional(),
  enter: BindingSchema.optional(),
  cues: z.record(BindingSchema).optional(), // keys are seconds into the state's anim, e.g. "0.30"
  ambient: z.object({ sfx: z.string(), every: range }).optional(),
  despawnAfter: z.number().min(0).optional(),
})
export type StateDef = z.infer<typeof StateSchema>

export const TrackSchema = z.object({
  node: z.string(),
  prop: z.enum(['pos.x', 'pos.y', 'pos.z', 'rot.x', 'rot.y', 'rot.z', 'scale']),
  ease: z.enum(['linear', 'sine', 'quadIn', 'quadOut', 'quadInOut', 'step']).optional(),
  keys: z.array(z.tuple([z.number().min(0), z.number()])).min(1),
})
export type TrackDef = z.infer<typeof TrackSchema>

export const ClipSchema = z.object({
  loop: z.boolean().optional(),
  duration: z.number().positive(),
  tracks: z.array(TrackSchema),
})
export type ClipDef = z.infer<typeof ClipSchema>

// Imported model descriptor — the GLB is the single source of truth for its geometry,
// materials, skeleton and clip names (we never mirror mesh/clip lists into the doc).
export const ModelSchema = z.object({
  src: z.string().min(1), // resources-relative, e.g. 'models/player-test/index.glb'
  // extra animation clips to MERGE from sibling Mixamo FBX files (filenames relative to the
  // GLB's folder). Retargeted onto the GLB skeleton at load and named after the file (minus
  // .fbx). Use when the GLB ships only its base clip (clips already baked into the GLB need
  // no entry). e.g. ["Running.fbx", "Reaction Hit.fbx"].
  anims: z.array(z.string()).optional(),
  // Per-part uniform emissive (glow). Keyed by the EXPOSED part name — a GLB mesh named
  // "<part>@exposeEmissive" opts in; the editor shows a colour+intensity control for it.
  // The part's material is cloned so only that part glows. Absent = the tagged part uses
  // a default glow until authored here.
  emissive: z.record(z.object({ color: hexColor, intensity: z.number().min(0).max(20) })).optional(),
  // DISMEMBERABLE parts, keyed by GLB mesh name — the ONLY persisted dismemberment data
  // (checkbox + weight in the editor). Everything else is DERIVED at load: each entry gets a
  // virtual modifier "dismembered_<part>" (hides the mesh — reversible, stackable) and a
  // virtual event "dismember_<part>" (bakes the part's current pose into a chunk and throws
  // it back, velocity ∝ 1/weight, then activates the modifier). Severed = HIDDEN, never removed.
  dismember: z.record(z.object({ weight: z.number().min(0.05).max(100) })).optional(),
})
export type ModelDef = z.infer<typeof ModelSchema>

export const EntitySchema = z.object({
  format: z.literal(1),
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  category: z.enum(['prop', 'pickup', 'enemy', 'character', 'levelpart']),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  // SKELETAL assembly (phase 1, rigid weights — see docs/SKELETAL_ANIMATION_RESEARCH.md):
  // build this entity as bones + SkinnedMesh instead of rigid groups. Node names become
  // bone names 1:1, so the anim tracks drive bones unchanged. Opt-in per entity —
  // skinned entities skip the per-entity merge (BatchedMesh cannot skin).
  skinned: z.boolean().optional(),
  // Imported glTF/GLB model. When present, this entity is NOT procedural: geometry,
  // skeleton, materials AND animation clips all come from the GLB (which ships its own
  // PBR maps — kept as-is, no in-editor material editing). `rig` + `materials` are then
  // empty ({}); `states` map state names to GLB clip names (see scripts/import-glb.ts).
  model: ModelSchema.optional(),
  materials: z.record(MaterialSchema),
  rig: z.record(NodeSchema).optional(), // imported GLB entities have no procedural rig
  physics: z
    .object({
      body: z.enum(['fixed', 'dynamic', 'kinematicCharacter']),
      collider: z
        .union([
          z.literal('auto'),
          z.object({
            shape: z.enum(['box', 'sphere', 'capsule', 'cylinder']),
            size: vec3.optional(),
            radius: z.number().positive().optional(),
            height: z.number().positive().optional(),
            offset: vec3.optional(),
          }),
        ])
        .optional(),
      mass: z.number().positive().optional(),
      friction: z.number().min(0).optional(),
      restitution: z.number().min(0).optional(),
    })
    .optional(),
  props: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
  // Geometry-composition variants. The studio rolls `count` LAYOUTS (oneOf/chance/
  // rotJitter picks) once into <id>.variants.json, then composes each against the
  // per-part baked geometry into <id>.geom.{i}.json; the runtime cycles the geom
  // files (never regenerates). "Regenerate variants" re-rolls the layouts; a craft
  // edit re-composes the SAME layouts (stable). Absent = a single composition.
  // Per-instance placement variety (scale/yaw/tilt/tint) is a level-editor concern.
  variants: z
    .object({
      count: z.number().int().min(1).optional(), // number of variant geom files to bake (default 1)
      // mutually exclusive structural alternatives: per group, exactly one of the
      // listed rig nodes is kept per variant, the others dropped.
      oneOf: z.record(z.array(z.string()).min(2)).optional(),
    })
    .optional(),
  // states is { initial: "name", <stateName>: StateDef, ... } — validated in validateEntity
  states: z.record(z.unknown()).optional(),
  // combineable visibility overlays (face expressions etc.) — one active at a time
  modifiers: z.record(ModifierSchema).optional(),
  anims: z.record(ClipSchema).optional(),
  events: z.record(BindingSchema).optional(),
})
export type EntityDoc = Omit<z.infer<typeof EntitySchema>, 'states'> & {
  states?: { initial: string } & Record<string, StateDef | string>
}

// ---------------------------------------------------------------------------
// material catalog (inventory/materials/<id>.json) — the named PBR library.
// The importer (scripts/import-materials.ts) writes these with RESOLVED map
// paths; the material manager edits `tuning`; entity slots reference `id`.

export const MAP_KINDS = ['color', 'normal', 'roughness', 'height', 'ao', 'metallic'] as const
export type MapKind = (typeof MAP_KINDS)[number]

// A material's texture maps — one path per kind, single resolution. (The old
// 1k/256/128 tiers were dropped: only 1k ships on disk, so the branch was dead.)
// No emissive map — materials never self-illuminate.
const mapSet = z.object({
  color: z.string().nullable(),
  normal: z.string().nullable(),
  roughness: z.string().nullable(),
  height: z.string().nullable(),
  ao: z.string().nullable(),
  metallic: z.string().nullable(),
})

export const MaterialTuningSchema = z.object({
  // No `tint` (materials render as their texture) and no `emissive` (no self-illum).
  roughness: z.number().min(0).max(2),
  metalness: z.number().min(0).max(1),
  normalScale: z.number().min(0).max(4),
  // parallax occlusion depth — UV displacement at full height. 0 = flat (no parallax even
  // when POM is globally on). Only meaningful for materials that ship a height map.
  height: z.number().min(0).max(0.5).optional(),
  // per-material parallax opt-IN: this material marches POM only when this is true AND the
  // global Render-panel parallax is on. Absent/false = plain flat sampling — shipping a
  // height map alone does NOT enable it. The studio deletes the key when unchecked.
  parallax: z.boolean().optional(),
  aoIntensity: z.number().min(0).max(2),
  opacity: z.number().min(0).max(1),
  cutout: z.boolean(),
  doubleSided: z.boolean(),
  // NOTE: no `flat` here — flat/smooth shading describes the SURFACE (how a shape
  // approximates curvature), not the substance, so it lives per-SLOT only
  // (MaterialDefSchema.flat). Unset = smooth.
  // optional: the importer does not write it (default density is 1); the studio /
  // hand-tuning may still set a per-material tiling density. factory reads it via
  // catalogDefaultUvScale (`?? 1`).
  uvScale: z.number().positive().optional(),
  // #27: alpha/opacity MASK texture — a SINGLE user-provided resource path
  // (resolution-independent; unlike the per-res `maps`, one file drives every
  // resolution). materials.ts binds it as material.alphaMap (green channel,
  // NearestFilter, NoColorSpace) and combines it with cutout (alphaTest) or
  // opacity<1 (transparent). Absent = no mask. Validated to exist on disk.
  alphaMap: z.string().min(1).optional(),
})
export type MaterialTuning = z.infer<typeof MaterialTuningSchema>

export const MaterialCatalogSchema = z.object({
  format: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string(),
  category: z.string(),
  maps: mapSet,
  tuning: MaterialTuningSchema,
})
export type MaterialCatalogDoc = z.infer<typeof MaterialCatalogSchema>

export function validateMaterialCatalog(raw: unknown): Validated<MaterialCatalogDoc> {
  const parsed = MaterialCatalogSchema.safeParse(raw)
  if (!parsed.success) return { issues: zodIssues(parsed.error) }
  const issues: string[] = []
  const doc = parsed.data
  // A fully-empty map set (no maps at any resolution) is a valid BLANK scaffold —
  // the "New material" button (#16) creates one; it renders magenta until maps are
  // assigned. But once ANY map is present, require the 1k color map so a partially
  // authored catalog material can't silently ship without its base color.
  const anyMap = MAP_KINDS.some((k) => doc.maps[k])
  if (anyMap && !doc.maps.color) issues.push('maps.color: catalog material has no color map')
  return { doc, issues }
}

// all non-null resolved map paths in a catalog doc (for on-disk existence checks).
export function catalogMapPaths(doc: MaterialCatalogDoc): string[] {
  const out: string[] = []
  for (const kind of MAP_KINDS) {
    const p = doc.maps[kind]
    if (p) out.push(p)
  }
  return out
}

// referenced map existence, at each declared resolution.
export function crossCheckMaterialCatalog(doc: MaterialCatalogDoc, ctx: CrossContext): string[] {
  const issues: string[] = []
  for (const p of catalogMapPaths(doc)) if (!ctx.hasTexture(p)) issues.push(`map file not found "${p}"`)
  // #27: the alpha mask is a single resolution-independent path — validate it too.
  if (doc.tuning.alphaMap && !ctx.hasTexture(doc.tuning.alphaMap))
    issues.push(`alpha mask file not found "${doc.tuning.alphaMap}"`)
  return issues
}

// ---------------------------------------------------------------------------
// effect (named gfx+sfx combo)

export const BurstSchema = z.object({
  count: z.number().int().min(1).max(256),
  size: range,
  aspect: vec3.optional(), // per-axis size multiplier: [2.6, 0.5, 0.3] makes planks instead of cubes
  offset: vec3.optional(), // spawn offset from the effect origin (origin = entity bbox center)
  speed: range,
  dir: z.enum(['sphere', 'up', 'ring']).optional(), // default sphere; ring = horizontal outward
  gravity: z.number().optional(), // y acceleration, m/s^2
  drag: z.number().min(0).optional(),
  life: range,
  colors: z.array(hexColor).min(1),
  inherit: z.boolean().optional(), // this burst takes the caller's texture/tint effect params
  geometry: z.enum(['cube', 'plank']).optional(), // plank = procedurally jittered debris (aspect = dims)
  fade: z.boolean().optional(), // default true — particles scale out (cubes) / fade out (flipbook)
  spin: z.number().optional(), // radians/sec magnitude
  delay: z.number().min(0).optional(),
  // camera-facing sprite playing a frame sequence over the particle's life,
  // instead of a colored cube. '#' in pattern is the frame index.
  flipbook: z
    .object({
      pattern: z.string().regex(/#/, 'pattern needs a # placeholder'),
      frames: z.number().int().min(2).max(64),
    })
    .optional(),
  sprite: z.string().optional(), // single static camera-facing sprite texture
  grow: z.number().positive().optional(), // size multiplier reached at end of life (sprites)
})
export type BurstDef = z.infer<typeof BurstSchema>

export const EffectSchema = z.object({
  format: z.literal(1),
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  notes: z.string().optional(),
  sfx: z.union([z.string(), z.array(z.string())]).optional(),
  particles: z.array(BurstSchema).optional(),
  flash: z
    .object({
      color: hexColor,
      intensity: z.number().positive(),
      radius: z.number().positive().optional(),
      duration: z.number().positive(),
    })
    .optional(),
  shake: z.number().min(0).optional(),
})
export type EffectDoc = z.infer<typeof EffectSchema>

// ---------------------------------------------------------------------------
// sfx (synthesized WebAudio patch)

const envelope = z.object({ from: z.number().min(0).optional(), to: z.number().min(0).optional() })
const freqSpec = z.union([
  z.object({ from: z.number().positive(), to: z.number().positive().optional() }),
  z.object({ steps: z.array(z.tuple([z.number().min(0), z.number().positive()])).min(1) }),
])

export const SfxLayerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tone'),
    wave: z.enum(['sine', 'square', 'triangle', 'sawtooth']),
    freq: freqSpec,
    gain: envelope.optional(),
    curve: z.enum(['lin', 'exp']).optional(),
    duration: z.number().positive(),
    start: z.number().min(0).optional(),
  }),
  z.object({
    type: z.literal('noise'),
    filter: z
      .object({
        type: z.enum(['lowpass', 'highpass', 'bandpass']),
        from: z.number().positive(),
        to: z.number().positive().optional(),
        q: z.number().positive().optional(),
      })
      .optional(),
    gain: envelope.optional(),
    curve: z.enum(['lin', 'exp']).optional(),
    duration: z.number().positive(),
    start: z.number().min(0).optional(),
  }),
])

export const SfxSchema = z
  .object({
    format: z.literal(1),
    id: z.string().regex(/^[a-z0-9_]+$/),
    name: z.string().optional(),
    notes: z.string().optional(),
    volume: z.number().min(0).max(1).optional(),
    pitch: z.number().min(0.25).max(4).optional(), // base pitch multiplier (sample rate / synth freqs)
    pitchJitter: z.number().min(0).max(1).optional(), // random pitch spread, fraction of an octave
    layers: z.array(SfxLayerSchema).min(1).optional(), // synthesized form
    files: z.array(z.string()).min(1).optional(), // sample form: paths relative to resources/, random pick per play
  })
  .refine((s) => (s.layers ? !s.files : !!s.files), {
    message: 'sfx needs exactly one of "layers" (synth) or "files" (samples)',
  })
export type SfxDoc = z.infer<typeof SfxSchema>

// ---------------------------------------------------------------------------
// validation beyond the raw shape

export function walkRig(rig: Record<string, NodeDef>, cb: (name: string, node: NodeDef) => void): void {
  const visit = (nodes: Record<string, NodeDef>) => {
    for (const [name, node] of Object.entries(nodes)) {
      cb(name, node)
      if (node.children) visit(node.children)
    }
  }
  visit(rig)
}

export function rigNodeNames(rig: Record<string, NodeDef>): Set<string> {
  const names = new Set<string>()
  walkRig(rig, (name) => names.add(name))
  return names
}

function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
}

function checkShapeParams(name: string, node: NodeDef, issues: string[]): void {
  const s = node.shape
  if (!s) {
    if (node.material) issues.push(`rig.${name}: material on a shapeless group node`)
    return
  }
  // a decal carries its own embedded image — the ONE shape with no material slot
  if (!node.material && s !== 'decal') issues.push(`rig.${name}: shape without material`)
  if (s === 'decal' && node.material) issues.push(`rig.${name}: decal carries its own image — material slot is ignored`)
  if (s === 'decal' && !node.image?.startsWith('data:image/'))
    issues.push(`rig.${name}: decal needs image (a data:image/…;base64 URI)`)
  if ((s === 'box' || s === 'plank' || s === 'arrow') && node.size?.length !== 3)
    issues.push(`rig.${name}: ${s} needs size [w,h,d]`)
  if ((s === 'plane' || s === 'cross' || s === 'decal') && node.size?.length !== 2)
    issues.push(`rig.${name}: ${s} needs size [w,h]`)
  if (s === 'mesh' && !node.mesh) issues.push(`rig.${name}: mesh needs a mesh path`)
  if ((s === 'cylinder' || s === 'post' || s === 'ring') && !(node.radius || (node.radiusTop && node.radiusBottom)))
    issues.push(`rig.${name}: ${s} needs radius (or radiusTop+radiusBottom)`)
  if ((s === 'cylinder' || s === 'post' || s === 'ring') && !node.height) issues.push(`rig.${name}: ${s} needs height`)
  if (s === 'ring' && !node.thickness) issues.push(`rig.${name}: ring needs thickness`)
  if ((s === 'cone' || s === 'capsule') && (!node.radius || !node.height))
    issues.push(`rig.${name}: ${s} needs radius + height`)
  if (s === 'sphere' && !node.radius) issues.push(`rig.${name}: sphere needs radius`)
  if (s === 'disk' && !node.radius) issues.push(`rig.${name}: disk needs radius`)
  if (s === 'star' && !node.radius) issues.push(`rig.${name}: star needs radius`)
  if (s === 'torus' && (!node.radius || !node.tube)) issues.push(`rig.${name}: torus needs radius + tube`)
}

export interface Validated<T> {
  doc?: T
  issues: string[]
}

export function validateEntity(raw: unknown): Validated<EntityDoc> {
  const parsed = EntitySchema.safeParse(raw)
  if (!parsed.success) return { issues: zodIssues(parsed.error) }
  const issues: string[] = []
  const doc = parsed.data as unknown as EntityDoc

  // Imported GLB entity: geometry/skeleton/materials/clips all live in the GLB. Its
  // state.anim values are GLB CLIP names (validated in the browser against the loaded
  // model, not here), and it has no procedural rig/anims. `rig`/`materials` are empty {}.
  const isImported = !!doc.model

  // item 34: inherit targets exist, no cycles, chains terminate in a material.
  // (Parent slots referenced by no geometry are LEGAL — they're group knobs.)
  checkSlotInheritance(doc.materials, issues)

  // an imported GLB carries its own hierarchy; anything else needs a rig to be anything at all
  if (!isImported && !doc.rig) issues.push('rig: required for non-imported entities')

  const nodeNames = rigNodeNames(doc.rig ?? {})
  const dupCheck = new Set<string>()
  walkRig(doc.rig ?? {}, (name, node) => {
    if (dupCheck.has(name)) issues.push(`rig: duplicate node name "${name}"`)
    dupCheck.add(name)
    checkShapeParams(name, node, issues)
    if (node.material) {
      const slots = typeof node.material === 'string' ? [node.material] : Object.values(node.material)
      for (const slot of slots)
        if (slot && !doc.materials[slot]) issues.push(`rig.${name}: unknown material slot "${slot}"`)
    }
  })

  // states: { initial, ...states }
  const states = doc.states as Record<string, unknown> | undefined
  const stateNames: string[] = []
  if (states) {
    if (typeof states.initial !== 'string') issues.push('states: missing "initial"')
    for (const [key, val] of Object.entries(states)) {
      if (key === 'initial') continue
      const st = StateSchema.safeParse(val)
      if (!st.success) {
        issues.push(...zodIssues(st.error).map((m) => `states.${key}.${m}`))
        continue
      }
      stateNames.push(key)
      const s = st.data
      // imported models: state.anim is a GLB clip name and show/hide are GLB mesh names —
      // both validated in the browser against the loaded GLB, not against rig/anims here.
      if (!isImported) {
        if (s.anim && !doc.anims?.[s.anim]) issues.push(`states.${key}: unknown anim "${s.anim}"`)
        for (const n of [...(s.show ?? []), ...(s.hide ?? [])])
          if (!nodeNames.has(n)) issues.push(`states.${key}: unknown node "${n}" in show/hide`)
      }
      for (const t of Object.keys(s.cues ?? {}))
        if (!(parseFloat(t) >= 0)) issues.push(`states.${key}: bad cue time "${t}"`)
    }
    if (typeof states.initial === 'string' && !stateNames.includes(states.initial))
      issues.push(`states: initial "${states.initial}" is not a defined state`)
  }

  for (const [clipName, clip] of Object.entries(doc.anims ?? {})) {
    for (const track of clip.tracks) {
      if (!nodeNames.has(track.node)) issues.push(`anims.${clipName}: unknown node "${track.node}"`)
      for (const [t] of track.keys)
        if (t > clip.duration + 1e-6) issues.push(`anims.${clipName}.${track.node}: key at ${t}s exceeds duration`)
    }
  }

  // binding.anim must reference a real clip (imported models: GLB clip names — checked in the
  // browser, not here); binding.modifier a declared modifier OR a derived dismemberment one
  // ("dismembered_<part>" exists implicitly for every model.dismember part); byContext keys "dim=value"
  const modifierKnown = (name: string): boolean => {
    if (doc.modifiers?.[name]) return true
    const part = /^dismembered_(.+)$/.exec(name)?.[1]
    return !!(part && doc.model?.dismember?.[part])
  }
  const checkBindingAnim = (where: string, b: unknown) => {
    const binding = b as Binding | undefined
    if (!binding) return
    if (!isImported && binding.anim && !doc.anims?.[binding.anim])
      issues.push(`${where}: unknown anim "${binding.anim}"`)
    if (binding.modifier && !modifierKnown(binding.modifier))
      issues.push(`${where}: unknown modifier "${binding.modifier}"`)
    for (const [key, override] of Object.entries(binding.byContext ?? {})) {
      if (!CONTEXT_KEY_RE.test(key)) issues.push(`${where}: bad context key "${key}" (expected dim=value)`)
      if (!isImported && override.anim && !doc.anims?.[override.anim])
        issues.push(`${where}[${key}]: unknown anim "${override.anim}"`)
      if (override.modifier && !modifierKnown(override.modifier))
        issues.push(`${where}[${key}]: unknown modifier "${override.modifier}"`)
    }
  }
  for (const [ev, b] of Object.entries(doc.events ?? {})) checkBindingAnim(`events.${ev}`, b)
  if (states)
    for (const [key, val] of Object.entries(states)) {
      if (key === 'initial') continue
      const s = val as StateDef
      checkBindingAnim(`states.${key}.enter`, s.enter)
      for (const [t, b] of Object.entries(s.cues ?? {})) checkBindingAnim(`states.${key}.cues[${t}]`, b)
    }

  for (const [group, names] of Object.entries(doc.variants?.oneOf ?? {})) {
    for (const n of names) if (!nodeNames.has(n)) issues.push(`variants.oneOf.${group}: unknown node "${n}"`)
  }

  // imported models: modifier show/hide reference GLB MESH names (live in the GLB, not the rig)
  if (!isImported)
    for (const [mod, def] of Object.entries(doc.modifiers ?? {})) {
      for (const n of [...(def.show ?? []), ...(def.hide ?? [])])
        if (!nodeNames.has(n)) issues.push(`modifiers.${mod}: unknown node "${n}" in show/hide`)
    }

  return { doc, issues }
}

export function validateEffect(raw: unknown): Validated<EffectDoc> {
  const parsed = EffectSchema.safeParse(raw)
  if (!parsed.success) return { issues: zodIssues(parsed.error) }
  const issues: string[] = []
  for (const [i, burst] of (parsed.data.particles ?? []).entries())
    if (burst.flipbook && burst.sprite) issues.push(`particles[${i}]: flipbook and sprite are mutually exclusive`)
  return { doc: parsed.data, issues }
}

export function validateSfx(raw: unknown): Validated<SfxDoc> {
  const parsed = SfxSchema.safeParse(raw)
  if (!parsed.success) return { issues: zodIssues(parsed.error) }
  return { doc: parsed.data, issues: [] }
}

// Cross-registry checks (references between files + texture existence).
export interface CrossContext {
  hasTexture(path: string): boolean
  isAnimatedTexture(path: string): boolean // minecraft .png.mcmeta strips — only usable via burst flipbook
  hasSound(path: string): boolean // audio file under resources/
  hasModel(path: string): boolean // external mesh file under resources/
  hasEffect(id: string): boolean
  hasSfx(id: string): boolean
  hasSurface(name: string): boolean // surface preset declared in settings.json
  hasMaterial(id: string): boolean // catalog material declared under inventory/materials/
}

export function flipbookFrames(fb: { pattern: string; frames: number }): string[] {
  return Array.from({ length: fb.frames }, (_, i) => fb.pattern.replace('#', String(i)))
}

function checkBinding(
  where: string,
  b: Binding | undefined,
  ctx: CrossContext,
  issues: string[],
  materials?: Record<string, MaterialDef>,
): void {
  if (!b) return
  const checkEffect = (e: EffectRef | undefined, at: string) => {
    const id = effectIdOf(e)
    // reserved SCRIPT_EFFECT_* ids are built-in runtime behaviors, not inventory effects
    if (id && !isScriptEffect(id) && !ctx.hasEffect(id)) issues.push(`${at}: unknown effect "${id}"`)
    const tex = effectParamsOf(e).texture
    if (tex && !ctx.hasTexture(tex)) issues.push(`${at}: effect texture not found "${tex}"`)
    if (typeof e === 'object' && e?.slot && materials && !materials[e.slot])
      issues.push(`${at}: effect inherits from unknown slot "${e.slot}"`)
  }
  if (b.sfx && !ctx.hasSfx(b.sfx)) issues.push(`${where}: unknown sfx "${b.sfx}"`)
  checkEffect(b.effect, where)
  for (const [key, o] of Object.entries(b.byContext ?? {})) {
    if (o.sfx && !ctx.hasSfx(o.sfx)) issues.push(`${where}[${key}]: unknown sfx "${o.sfx}"`)
    checkEffect(o.effect, `${where}[${key}]`)
  }
}

export function crossCheckEntity(doc: EntityDoc, ctx: CrossContext): string[] {
  const issues: string[] = []
  for (const [slot, mat] of Object.entries(doc.materials)) {
    // a slot's own catalog reference must exist (inherit-only slots carry none —
    // their chain's terminal slot is checked as itself)
    if (mat.material !== undefined && !ctx.hasMaterial(mat.material))
      issues.push(`materials.${slot}: unknown catalog material "${mat.material}"`)
  }
  // imported GLB source must exist on disk (mesh/clip coverage is checked in the browser)
  if (doc.model?.src && !ctx.hasModel(doc.model.src)) issues.push(`model.src: model file not found "${doc.model.src}"`)
  walkRig(doc.rig ?? {}, (name, node) => {
    if (node.shape === 'mesh' && node.mesh && !ctx.hasModel(node.mesh))
      issues.push(`rig.${name}: mesh file not found "${node.mesh}"`)
  })
  if (doc.states) {
    for (const [key, val] of Object.entries(doc.states)) {
      if (key === 'initial' || typeof val === 'string') continue
      const s = val as StateDef
      checkBinding(`states.${key}.enter`, s.enter, ctx, issues, doc.materials)
      for (const [t, b] of Object.entries(s.cues ?? {}))
        checkBinding(`states.${key}.cues[${t}]`, b, ctx, issues, doc.materials)
      if (s.ambient && !ctx.hasSfx(s.ambient.sfx)) issues.push(`states.${key}.ambient: unknown sfx "${s.ambient.sfx}"`)
    }
  }
  for (const [ev, b] of Object.entries(doc.events ?? {})) checkBinding(`events.${ev}`, b, ctx, issues, doc.materials)
  return issues
}

export function crossCheckEffect(doc: EffectDoc, ctx: CrossContext): string[] {
  const issues: string[] = []
  const sfx = doc.sfx == null ? [] : Array.isArray(doc.sfx) ? doc.sfx : [doc.sfx]
  for (const id of sfx) if (!ctx.hasSfx(id)) issues.push(`sfx: unknown sfx "${id}"`)
  for (const [i, burst] of (doc.particles ?? []).entries()) {
    if (burst.flipbook)
      for (const frame of flipbookFrames(burst.flipbook))
        if (!ctx.hasTexture(frame)) issues.push(`particles[${i}]: flipbook frame not found "${frame}"`)
    if (burst.sprite && !ctx.hasTexture(burst.sprite))
      issues.push(`particles[${i}]: sprite texture not found "${burst.sprite}"`)
  }
  return issues
}

export function crossCheckSfx(doc: SfxDoc, ctx: CrossContext): string[] {
  const issues: string[] = []
  for (const f of doc.files ?? []) if (!ctx.hasSound(f)) issues.push(`files: sound not found "${f}"`)
  return issues
}

export function statesOf(doc: EntityDoc): { initial: string | null; states: Record<string, StateDef> } {
  const out: Record<string, StateDef> = {}
  let initial: string | null = null
  for (const [key, val] of Object.entries(doc.states ?? {})) {
    if (key === 'initial') initial = val as string
    else out[key] = val as StateDef
  }
  return { initial, states: out }
}
