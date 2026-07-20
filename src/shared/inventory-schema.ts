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
 The animation profile. Types are declared by hand (readonly: a profile is shared by reference
 by every entity of its archetype) and the schemas are ANNOTATED with them, so a schema that
 drifts from its type refuses to compile.
*/
export type LocomotionBand = {
  readonly above?: number // band lower bound, m/s; the first band omits it
  readonly clip: string
  readonly nativeSpeed: number // ground speed the clip depicts at rate 1; 0 = depicts no travel
  readonly fade: number
}

export type LocomotionSet = {
  readonly forward: readonly LocomotionBand[]
  readonly back?: readonly LocomotionBand[]
  readonly left?: readonly LocomotionBand[]
  readonly right?: readonly LocomotionBand[]
}

export type ClipPlay = {
  readonly clip: string
  readonly rate: number
  readonly fade: number
}

export type AnimationProfileState = {
  readonly locomotion: LocomotionSet
  readonly lifecycle?: {
    readonly rise?: ClipPlay
    readonly death?: ClipPlay
  }
}

const LocomotionBandSchema: z.ZodType<LocomotionBand> = z.object({
  above: z.number().nonnegative().optional(),
  clip: z.string().min(1),
  nativeSpeed: z.number().nonnegative(),
  fade: z.number().nonnegative(),
})

const LocomotionSetSchema: z.ZodType<LocomotionSet> = z.object({
  forward: z.array(LocomotionBandSchema).min(1),
  back: z.array(LocomotionBandSchema).min(1).optional(),
  left: z.array(LocomotionBandSchema).min(1).optional(),
  right: z.array(LocomotionBandSchema).min(1).optional(),
})

const ClipPlaySchema: z.ZodType<ClipPlay> = z.object({
  clip: z.string().min(1),
  rate: z.number().positive(),
  fade: z.number().nonnegative(),
})

const AnimationProfileSchema: z.ZodType<AnimationProfileState> = z.object({
  locomotion: LocomotionSetSchema,
  lifecycle: z
    .object({
      rise: ClipPlaySchema.optional(),
      death: ClipPlaySchema.optional(),
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
