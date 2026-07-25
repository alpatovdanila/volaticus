import { BoxGeometry, BufferGeometry, Material, Mesh, MeshNormalMaterial, PlaneGeometry } from 'three'

import { IsPlayer, IsSolid, NeedsSpawn, Position, Rotation, SceneObject, writeVec3Row } from '@components'
import { Behaviour, LevelDeclaration, LevelObject, PrimitiveObject, parseLevelDeclaration } from '@lib/level.schema'
import { BaseService, IServicesRegistry, KnownServices } from './services-registry'

const BEHAVIOUR_TAGS: Record<Behaviour, object> = {
  player: IsPlayer,
  solid: IsSolid,
}

const levelUrl = (name: string) => `/src/game/levels/${name}.json`

/*
Turns a level declaration into entities. WHICH level to load is the caller's call — this
service only knows how to fetch, validate and spawn one.

Models are still placeholders: their inventoryId is validated but not resolved.
*/
export class Level extends BaseService {
  private world!: KnownServices['world']
  private loader!: KnownServices['loader']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
    this.loader = registry.get('loader')
  }

  async start() {
    // no camera in the level format yet — a viewpoint that can see a ground plane
    this.world.camera.position.set(0, 3, 9)
    this.world.camera.lookAt(0, 1, 0)
  }

  async load(name: string) {
    const level = parseLevelDeclaration(name, await this.loader.json.load(levelUrl(name)))

    // environment and materials are independent fetches — resolve everything before spawning so
    // the level appears at once rather than half-built
    const ids = level.objects.filter(isPrimitive).map((object) => object.primitive.material.inventoryId)
    const [materials] = await Promise.all([
      Promise.all([...new Set(ids)].map(async (id) => [id, await this.loader.material.load(id)] as const)),
      this.applyEnvironment(level.environment),
    ])

    for (const object of level.objects) this.spawn(object, new Map(materials))
  }

  private async applyEnvironment(environment: LevelDeclaration['environment']) {
    if (!environment) return

    const { scene } = this.world
    const texture = await this.loader.hdri.load(environment.hdri.inventoryId)

    scene.environment = texture
    scene.environmentIntensity = environment.hdri.intensity
    scene.environmentRotation.set(...environment.hdri.rotation)

    if (!environment.showSky) return
    scene.background = texture
    // rotate the visible sky with the lighting, so the two cannot drift apart
    scene.backgroundRotation.copy(scene.environmentRotation)
  }

  private spawn(object: LevelObject, materials: Map<string, Material>) {
    const eid = this.world.addEntity(Position, Rotation, SceneObject, NeedsSpawn)

    SceneObject[eid] = meshFor(object, materials)
    writeVec3Row(Position, eid, object.position)
    writeVec3Row(Rotation, eid, object.rotation)

    for (const behaviour of object.behaviour) this.world.addComponent(eid, BEHAVIOUR_TAGS[behaviour])
  }
}

const isPrimitive = (object: LevelObject): object is PrimitiveObject => object.type === 'primitive'

const meshFor = (object: LevelObject, materials: Map<string, Material>): Mesh => {
  if (!isPrimitive(object)) return new Mesh(new BoxGeometry(0.6, 1.8, 0.4), new MeshNormalMaterial())

  const [width, height] = object.primitive.size
  const geometry = new PlaneGeometry(width, height)
  meterUv(geometry, object.primitive.material.uv.mode, width, height)

  return new Mesh(geometry, materials.get(object.primitive.material.inventoryId))
}

/*
Tiling goes into the geometry's UVs rather than texture.repeat: repeat lives on the texture, and
the texture is shared, so two objects of different sizes would overwrite each other's metering.

`projection` does not branch yet — on a plane, box/planar/sphere all reduce to the plane's own
local UVs. It starts mattering with the first primitive that is not flat.
*/
const meterUv = (geometry: BufferGeometry, mode: 'tile' | 'fit' | 'stretch', width: number, height: number) => {
  const repeats =
    mode === 'stretch'
      ? [1, 1]
      : mode === 'fit'
        ? [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))]
        : [width, height] // tile: one repeat per meter

  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * repeats[0], uv.getY(i) * repeats[1])
  uv.needsUpdate = true
}

export type ILevel = InstanceType<typeof Level>
