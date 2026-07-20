import { z } from 'zod'

/*
 The baked inventory entity format (inventory/entities/<id>/<id>.json), written by
 scripts/import-glb.ts. Defined once as a schema; the type is inferred from it so a doc and
 the type describing it cannot drift apart.

 Only `id` and `model.src` are required — everything else varies across the catalog
 (shielder has no anims, only alyosha/shielder declare dismember, only small_zombie has
 modifiers).
*/

const EmissiveSchema = z.object({
  color: z.string(),
  intensity: z.number(),
})

const DismemberPartSchema = z.object({
  weight: z.number(),
})

const ModelSchema = z.object({
  src: z.string(), // relative to resources/, e.g. "models/marine2/index.glb"
  anims: z.array(z.string()).optional(),
  // uniform scale applied to the instance root at build time. Character sizing is per-model
  // tuning (a Tripo export's absolute size is arbitrary), so it lives in the doc, not in code.
  // Required: every model states its size, 1 included — no absent-means-something convention.
  scale: z.number().positive(),
  emissive: z.record(EmissiveSchema).optional(),
  dismember: z.record(DismemberPartSchema).optional(),
})

const ModifierSchema = z.object({
  hide: z.array(z.string()).optional(),
})

/*
 The animation profile: every clip an entity can play, with its tuning. Tuning lives HERE and
 only here; systems reference entries, they do not copy numbers out.

 Types are declared by hand (readonly: a profile is shared by reference by every entity of its
 archetype) and the schemas are ANNOTATED with them, so a schema that drifts from its type
 refuses to compile. Every block is optional — a profile states what its rig actually has.
*/
export type LocomotionBand = {
  readonly above?: number // band lower bound, m/s; the first band omits it
  readonly clip: string
  readonly rate?: number // playback rate; absent plays as authored (1)
  readonly fade?: number // crossfade in, seconds; absent cuts
}

export type LocomotionSet = {
  readonly forward: readonly LocomotionBand[]
  readonly back?: readonly LocomotionBand[]
  readonly left?: readonly LocomotionBand[]
  readonly right?: readonly LocomotionBand[]
}

// a clip played at someone's command rather than resolved from movement
export type EventClip = {
  readonly clip: string
  readonly rate?: number // playback rate; absent plays as authored (1)
  readonly fade?: number // crossfade in, seconds; absent cuts
  readonly repeats?: number // how many passes; absent plays one
}

export type LifecycleSet = {
  readonly rise?: EventClip
  readonly death?: EventClip
}

export type ActionsSet = {
  readonly hit?: EventClip
  readonly sit?: EventClip
  readonly jump?: EventClip
}

export type AnimationProfileState = {
  readonly locomotion?: LocomotionSet
  readonly lifecycle?: LifecycleSet
  readonly actions?: ActionsSet
}

// every animation an event can name; whether a PARTICULAR profile has it is that profile's business
export type AnimationEventName = keyof LifecycleSet | keyof ActionsSet

const LocomotionBandSchema: z.ZodType<LocomotionBand> = z.object({
  above: z.number().nonnegative().optional(),
  clip: z.string().min(1),
  rate: z.number().positive().optional(),
  fade: z.number().nonnegative().optional(),
})

const LocomotionSetSchema: z.ZodType<LocomotionSet> = z.object({
  forward: z.array(LocomotionBandSchema).min(1),
  back: z.array(LocomotionBandSchema).min(1).optional(),
  left: z.array(LocomotionBandSchema).min(1).optional(),
  right: z.array(LocomotionBandSchema).min(1).optional(),
})

const EventClipSchema: z.ZodType<EventClip> = z.object({
  clip: z.string().min(1),
  rate: z.number().positive().optional(),
  fade: z.number().nonnegative().optional(),
  repeats: z.number().int().positive().optional(),
})

const AnimationProfileSchema: z.ZodType<AnimationProfileState> = z.object({
  locomotion: LocomotionSetSchema.optional(),
  lifecycle: z
    .object({
      rise: EventClipSchema.optional(),
      death: EventClipSchema.optional(),
    })
    .optional(),
  actions: z
    .object({
      hit: EventClipSchema.optional(),
      sit: EventClipSchema.optional(),
      jump: EventClipSchema.optional(),
    })
    .optional(),
})

export const InventoryEntityDeclarationSchema = z.object({
  format: z.number().optional(),
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  model: ModelSchema,
  materials: z.record(z.unknown()).optional(),
  modifiers: z.record(ModifierSchema).optional(),
  animationProfile: AnimationProfileSchema.optional(),
})

export type InventoryEntityDeclaration = z.infer<typeof InventoryEntityDeclarationSchema>

export const parseInventoryEntityDeclaration = (id: string, data: unknown): InventoryEntityDeclaration => {
  const result = InventoryEntityDeclarationSchema.safeParse(data)
  if (result.success) return result.data

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`invalid inventory entity '${id}':\n${issues}`)
}
