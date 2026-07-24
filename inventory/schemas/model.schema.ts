import { z } from 'zod'

/*
 The components item format (inventory/items/models/<id>/<id>.json) — the doc the loader validates
 before building an entity. Defined once as a schema; types are inferred from it (or annotate
 it) so a doc and the type describing it cannot drift apart.

 Only `id` and `file` are required — uniform with every other item type. Everything else is
 hand tuning, authored after the bake — absent means "not tuned yet", never a hidden default.
*/

const DismemberPartSchema = z.object({
  weight: z.number(),
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

export const ModelDeclarationSchema = z.object({
  format: z.number().optional(),
  id: z.string(),
  // doc-relative: the baked GLB sits beside the json ("index.baked.glb")
  file: z.string().min(1),
  dismember: z.record(DismemberPartSchema).optional(),
  animationProfile: AnimationProfileSchema.optional(),
})

export type ModelDeclaration = z.infer<typeof ModelDeclarationSchema>

export const parseModelDeclaration = (id: string, data: unknown): ModelDeclaration => {
  const result = ModelDeclarationSchema.safeParse(data)
  if (result.success) return result.data

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`invalid model '${id}':\n${issues}`)
}
