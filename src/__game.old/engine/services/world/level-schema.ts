import { z } from 'zod'
import { Vec3Row } from '../../../lib/type'
import { HDRIS, hdriExists } from '../../../../lib/hdri-registry'

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

/*
 Image-based lighting, named with the SAME hdri ids the editor uses (src/lib/hdri-registry.ts),
 so a look set up in the studio can be transcribed into a level verbatim.

 The id is VALIDATED against the catalog rather than falling back to a default: silently
 lighting the level with the wrong sky because of a typo is far worse than refusing to load.
*/
const EnvironmentSchema = z.object({
  hdri: z.string().refine(hdriExists, (id) => ({
    message: `unknown hdri '${id}'. Known ids: ${HDRIS.map((h) => h.id).join(', ')}`,
  })),
  // display transform. none = WYSIWYG (clips >1), aces/agx = filmic HDR roll-off
  tonemap: z.enum(['none', 'aces', 'agx']).default('agx'),
  rotation: z.number().default(0), // env yaw in DEGREES — spins the sky and its lighting together
  intensity: z.number().default(1), // IBL strength -> scene.environmentIntensity
  // false keeps the HDRI's lighting but leaves `background` showing, for levels that want a
  // flat backdrop rather than a photographic sky
  showSky: z.boolean().default(true),
})

export type EnvironmentDeclaration = z.infer<typeof EnvironmentSchema>

const SceneObjectSchema = z.discriminatedUnion('type', [
  MeshObjectSchema,
  LightObjectSchema,
  InventoryEntityObjectSchema,
])

export const LevelDeclarationSchema = z.object({
  scene: z.object({
    // shown when there is no environment, and behind it while the HDRI streams in
    background: z.string(),
    environment: EnvironmentSchema.optional(),
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
