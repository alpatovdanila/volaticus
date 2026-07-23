import { z } from 'zod'

/*
 The hdri item format (inventory/items/hdri/<id>/<id>.json) — a POINTER doc. The environment
 itself is the KTX2 (UASTC HDR) equirect that inventory/scripts/bake-hdri.ts writes; `file`
 is its doc-relative name.
*/

export const HdriDeclarationSchema = z.object({
  format: z.number().optional(),
  id: z.string(),
  file: z.string().min(1),
  // unit vector toward the dominant light, derived from the payload by
  // inventory/scripts/extract-sun.ts. ABSENT means the sky has no distinct sun
  // (uniform painted domes) — consumers decide what that means, never a fallback here.
  sun: z.tuple([z.number(), z.number(), z.number()]).optional(),
})

export type HdriDeclaration = z.infer<typeof HdriDeclarationSchema>

export const parseHdriDeclaration = (id: string, data: unknown): HdriDeclaration => {
  const result = HdriDeclarationSchema.safeParse(data)
  if (result.success) return result.data

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`invalid hdri '${id}':\n${issues}`)
}
