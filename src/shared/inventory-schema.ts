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

export const InventoryEntityDeclarationSchema = z.object({
  format: z.number().optional(),
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  model: ModelSchema,
  materials: z.record(z.unknown()).optional(),
  modifiers: z.record(ModifierSchema).optional(),
})

export type InventoryEntityDeclaration = z.infer<typeof InventoryEntityDeclarationSchema>

export const parseInventoryEntityDeclaration = (id: string, data: unknown): InventoryEntityDeclaration => {
  const result = InventoryEntityDeclarationSchema.safeParse(data)
  if (result.success) return result.data

  const issues = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
  throw new Error(`invalid inventory entity '${id}':\n${issues}`)
}
