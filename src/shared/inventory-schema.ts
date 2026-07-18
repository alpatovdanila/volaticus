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
  emissive: z.record(EmissiveSchema).optional(),
  dismember: z.record(DismemberPartSchema).optional(),
})

/*
 `states` mixes a scalar entry with named ones: { initial: "index", index: { anim: "index" } }.
 Modelled as-is rather than reshaped — this is the baked format, the bake scripts own it.
*/
const StatesSchema = z.record(z.union([z.string(), z.object({ anim: z.string() })]))

const EventSchema = z.object({
  anim: z.string().optional(),
  modifier: z.string().optional(),
  effect: z
    .object({
      id: z.string(),
      part: z.string().optional(),
      delay: z.number().optional(),
    })
    .optional(),
})

const ModifierSchema = z.object({
  hide: z.array(z.string()).optional(),
})

export const InventoryEntityDeclarationSchema = z.object({
  format: z.number().optional(),
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
  model: ModelSchema,
  materials: z.record(z.unknown()).optional(),
  rig: z.record(z.unknown()).optional(),
  states: StatesSchema.optional(),
  modifiers: z.record(ModifierSchema).optional(),
  events: z.record(EventSchema).optional(),
  // which clips drive locomotion; clip names match the merged FBX filenames
  locomotion: z
    .object({
      idle: z.string(),
      walk: z.string(),
      run: z.string(),
    })
    .optional(),
})

export type InventoryEntityDeclaration = z.infer<typeof InventoryEntityDeclarationSchema>

export const parseInventoryEntityDeclaration = (id: string, data: unknown): InventoryEntityDeclaration => {
  const result = InventoryEntityDeclarationSchema.safeParse(data)
  if (result.success) return result.data

  const issues = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
  throw new Error(`invalid inventory entity '${id}':\n${issues}`)
}
