import { z } from 'zod'

/*
 The material item format (inventory/items/materials/<id>/<id>.json) — written by
 inventory/scripts/bake-material.ts, hand-tuned afterward. Defined once as a schema; the type
 is inferred from it so a doc and the type describing it cannot drift apart.

 `maps` values are doc-relative filenames ("color.ktx2" beside the json). `color` is the only
 required map — a material states what it actually ships. `tuning` carries the scalars the
 renderer applies; every field is defaulted, so a bare doc means "as authored".
*/

const MapsSchema = z.object({
  color: z.string().min(1),
  normal: z.string().min(1).optional(),
  roughness: z.string().min(1).optional(),
  ao: z.string().min(1).optional(),
  metallic: z.string().min(1).optional(),
})

const TuningSchema = z.object({
  roughness: z.number().min(0).max(2).default(1),
  metalness: z.number().min(0).max(1).default(0),
  normalScale: z.number().min(0).max(4).default(1),
  aoIntensity: z.number().min(0).max(2).default(1),
})

export const MaterialDeclarationSchema = z.object({
  format: z.number().optional(),
  id: z.string(),
  maps: MapsSchema,
  tuning: TuningSchema.default({}),
})

export type MaterialDeclaration = z.infer<typeof MaterialDeclarationSchema>

export const parseMaterialDeclaration = (id: string, data: unknown): MaterialDeclaration => {
  const result = MaterialDeclarationSchema.safeParse(data)
  if (result.success) return result.data

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`invalid material '${id}':\n${issues}`)
}
