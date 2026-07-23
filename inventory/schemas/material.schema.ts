import { z } from 'zod'

/*
 The material item format (inventory/items/materials/<id>/<id>.json) — a POINTER doc. The
 material itself lives entirely inside the GLB that inventory/scripts/bake-material.ts
 writes: textures embedded via KHR_texture_basisu, AO/roughness/metallic packed into one ORM
 image, tuning carried as real glTF material factors. `file` is the GLB's doc-relative name.

 Tune by editing the GLB's factors (the baker preserves them on re-bake) — this doc does not
 grow fields.
*/

export const MaterialDeclarationSchema = z.object({
  format: z.number().optional(),
  id: z.string(),
  file: z.string().min(1),
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
