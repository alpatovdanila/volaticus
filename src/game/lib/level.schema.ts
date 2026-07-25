import { z } from 'zod'
import { Vec3Row } from './type'

/*
 The level file format (src/game/levels/<name>.json). Positions are meters, rotations are
 radians — both go straight into the Position/Rotation components without conversion.

 inventoryId values name inventory items (inventory/items/<type>/<id>/) and are carried
 through as ids; resolving them to materials/models is the loader's business, not this file's.
*/

const Vec3 = z.tuple([z.number(), z.number(), z.number()])
const originVec3 = (): Vec3Row => [0, 0, 0]

// omitted fields default instead of reaching the loader as undefined
const common = {
  position: Vec3.default(originVec3),
  rotation: Vec3.default(originVec3),
  // named behaviours the loader turns into tag components — an unknown name is a load error,
  // not a silently ignored line
  behaviour: z.array(z.enum(['player', 'solid'])).default([]),
}

const UvSchema = z.object({
  // how the texture is wrapped onto the geometry: box = per-face planar,
  // planar = from above, sphere = around center
  projection: z.enum(['box', 'planar', 'sphere']).default('box'),
  // how it is metered once projected: tile = repeats per meter, fit = whole repeats over
  // the extent, stretch = exactly once over the extent
  mode: z.enum(['tile', 'fit', 'stretch']).default('tile'),
})

const MaterialRefSchema = z.object({
  inventoryId: z.string().min(1),
  uv: UvSchema.default({}),
})

const PrimitiveObjectSchema = z.object({
  type: z.literal('primitive'),
  ...common,
  primitive: z.object({
    type: z.literal('plane'),
    size: z.tuple([z.number().positive(), z.number().positive()]),
    material: MaterialRefSchema,
  }),
})

const ModelObjectSchema = z.object({
  type: z.literal('model'),
  ...common,
  model: z.object({ inventoryId: z.string().min(1) }),
})

const EnvironmentSchema = z.object({
  hdri: z.object({
    inventoryId: z.string().min(1),
    intensity: z.number().default(1),
    rotation: Vec3.default(originVec3),
  }),
  // false keeps the hdri's lighting but leaves the flat background showing
  showSky: z.boolean().default(true),
})

const LevelObjectSchema = z.discriminatedUnion('type', [PrimitiveObjectSchema, ModelObjectSchema])

export const LevelDeclarationSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  environment: EnvironmentSchema.optional(),
  objects: z.array(LevelObjectSchema).default([]),
})

export type LevelDeclaration = z.infer<typeof LevelDeclarationSchema>
export type LevelObject = z.infer<typeof LevelObjectSchema>
export type PrimitiveObject = z.infer<typeof PrimitiveObjectSchema>
export type ModelObject = z.infer<typeof ModelObjectSchema>
export type Behaviour = LevelObject['behaviour'][number]

export const parseLevelDeclaration = (name: string, data: unknown): LevelDeclaration => {
  const result = LevelDeclarationSchema.safeParse(data)
  if (result.success) return result.data

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`invalid level '${name}':\n${issues}`)
}
