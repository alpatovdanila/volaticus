import { z } from 'zod'
import { Vec3Row } from '../../../lib/type'

const Vec3 = z.tuple([z.number(), z.number(), z.number()])
const originVec3 = (): Vec3Row => [0, 0, 0]

// omitted transforms default instead of reaching the loader as undefined
const transform = {
  position: Vec3.default(originVec3),
  rotation: Vec3.default(originVec3),
}

const MeshObjectSchema = z.object({
  type: z.literal('mesh'),
  ...transform,
  mesh: z.object({
    geometry: z.object({
      type: z.literal('plane'),
      width: z.number(),
      height: z.number(),
      tiles: z.number(),
    }),
    inventoryMaterial: z.string(),
  }),
})

const LightObjectSchema = z.object({
  type: z.literal('light'),
  ...transform,
  light: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('directional'),
      color: z.string(),
      intensity: z.number(),
    }),
    z.object({
      kind: z.literal('hemisphere'),
      skyColor: z.string(),
      groundColor: z.string(),
      intensity: z.number(),
    }),
  ]),
})

const InventoryEntityObjectSchema = z.object({
  type: z.literal('inventoryEntity'),
  ...transform,
  inventoryEntity: z.string(),
  isPlayer: z.boolean().default(false),
})

const SceneObjectSchema = z.discriminatedUnion('type', [
  MeshObjectSchema,
  LightObjectSchema,
  InventoryEntityObjectSchema,
])

export const LevelDeclarationSchema = z.object({
  scene: z.object({
    camera: z.object({
      initialPosition: Vec3.default(originVec3),
      initialRotation: Vec3.default(originVec3),
      // no aspect: it belongs to the screen, not the level — DeviceScreen owns it
      initialOptions: z.object({
        fov: z.number(),
        near: z.number(),
        far: z.number(),
      }),
    }),
    background: z.string(),
    objects: z.array(SceneObjectSchema),
  }),
})

export type LevelDeclaration = z.infer<typeof LevelDeclarationSchema>
export type SceneObject = z.infer<typeof SceneObjectSchema>
export type MeshObject = z.infer<typeof MeshObjectSchema>
export type LightObject = z.infer<typeof LightObjectSchema>
export type InventoryEntityObject = z.infer<typeof InventoryEntityObjectSchema>

export const parseLevelDeclaration = (data: unknown): LevelDeclaration => {
  const result = LevelDeclarationSchema.safeParse(data)
  if (result.success) return result.data

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`invalid level declaration:\n${issues}`)
}
