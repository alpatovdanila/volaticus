import { AnimationMixer, BufferGeometry, Material, Mesh, Object3D, PlaneGeometry } from 'three'
// from three/webgpu, not three: the bare export is typed against WebGLRenderer, and this is the
// same class the renderer's own PMREMNode instantiates
import { PMREMGenerator } from 'three/webgpu'

import {
  AnimationProfile,
  IsPlayer,
  IsSolid,
  NeedsSpawn,
  Position,
  Rotation,
  SceneObject,
  ThreeAnimator,
  Velocity,
  writeVec3Row,
} from '@components'
import { LoadedModel } from './loaders/model-loader'
import {
  Behaviour,
  LevelDeclaration,
  LevelObject,
  ModelObject,
  PrimitiveObject,
  parseLevelDeclaration,
} from '@lib/level.schema'
import { BaseService, IServicesRegistry, KnownServices } from './services-registry'

const BEHAVIOUR_TAGS: Record<Behaviour, object> = {
  player: IsPlayer,
  solid: IsSolid,
}

// still loose files on the server rather than bundled modules, so a level can be swapped without
// a rebuild. The build copies src/game/levels next to the bundle to keep this one path true
const levelUrl = (name: string) => `${import.meta.env.BASE_URL}src/game/levels/${name}.json`

/*
Turns a level declaration into entities. WHICH level to load is the caller's call — this
service only knows how to fetch, validate and spawn one.

Models are still placeholders: their inventoryId is validated but not resolved.
*/
export class Level extends BaseService {
  private world!: KnownServices['world']
  private loader!: KnownServices['loader']
  private renderer!: KnownServices['renderer']

  init(registry: IServicesRegistry) {
    this.world = registry.get('world')
    this.loader = registry.get('loader')
    this.renderer = registry.get('renderer')
  }

  async load(name: string) {
    const level = parseLevelDeclaration(name, await this.loader.json.load(levelUrl(name)))

    // every asset is an independent fetch — resolve them all before spawning so the level
    // appears at once rather than half-built
    const materialIds = level.objects.filter(isPrimitive).map((object) => object.primitive.material.inventoryId)
    const modelIds = level.objects.filter(isModel).map((object) => object.model.inventoryId)

    const [materials, models] = await Promise.all([
      resolve(materialIds, (id) => this.loader.material.load(id)),
      resolve(modelIds, (id) => this.loader.model.load(id)),
      this.applyEnvironment(level.environment),
    ])

    for (const object of level.objects) this.spawn(object, materials, models)
  }

  private async applyEnvironment(environment: LevelDeclaration['environment']) {
    if (!environment) return

    const { scene } = this.world
    const texture = await this.loader.hdri.load(environment.hdri.inventoryId)

    /*
    Prefiltered HERE, once, rather than left to the renderer to derive.

    An equirect on scene.environment makes three build a PMREM behind our back, and PMREMNode
    rebuilds it whenever its version check fails to settle — which on some devices is every single
    frame, each one a fresh ~6MB texture that is never released. It reached 10GB on a phone and
    killed the tab.

    A texture that is ALREADY cubeUV takes the branch above that one and is used as-is, so there
    is nothing left to regenerate on any device.
    */
    const prefilter = new PMREMGenerator(this.renderer.webGPURenderer)
    scene.environment = prefilter.fromEquirectangular(texture).texture
    prefilter.dispose() // the generator's scratch targets, not the environment it just produced
    scene.environmentIntensity = environment.hdri.intensity
    scene.environmentRotation.set(...environment.hdri.rotation)

    if (!environment.showSky) return
    scene.background = texture
    // rotate the visible sky with the lighting, so the two cannot drift apart
    scene.backgroundRotation.copy(scene.environmentRotation)
  }

  private spawn(object: LevelObject, materials: Map<string, Material>, models: Map<string, LoadedModel>) {
    const eid = this.world.addEntity(Position, Rotation, SceneObject, NeedsSpawn)

    SceneObject[eid] = objectFor(object, materials, models)
    writeVec3Row(Position, eid, object.position)
    writeVec3Row(Rotation, eid, object.rotation)

    // models are the things that move; a primitive is scenery. Zeroed, but present, so movement
    // and locomotion queries match it before anything has pushed it anywhere
    if (isModel(object)) {
      this.world.addComponent(eid, Velocity)
      writeVec3Row(Velocity, eid, [0, 0, 0])
    }

    // conditional: a model without a profile must not match a query for one
    const profile = isModel(object) ? models.get(object.model.inventoryId)?.doc.animationProfile : undefined
    if (profile) {
      this.world.addComponent(eid, AnimationProfile)
      AnimationProfile[eid] = profile
    }

    // a mixer is worth having wherever there are clips to bind, profile or not.
    // NOTE model objects are shared per id — two entities on one model would get two mixers
    // driving the same skeleton. Whoever adds the second model entity owns that
    const animated = SceneObject[eid].animations
    if (animated?.length) {
      this.world.addComponent(eid, ThreeAnimator)
      ThreeAnimator[eid] = new AnimationMixer(SceneObject[eid])
    }

    for (const behaviour of object.behaviour) this.world.addComponent(eid, BEHAVIOUR_TAGS[behaviour])
  }
}

const isPrimitive = (object: LevelObject): object is PrimitiveObject => object.type === 'primitive'
const isModel = (object: LevelObject): object is ModelObject => object.type === 'model'

// one entry per distinct id, resolved concurrently
const resolve = async <T>(ids: string[], load: (id: string) => Promise<T>): Promise<Map<string, T>> =>
  new Map(await Promise.all([...new Set(ids)].map(async (id) => [id, await load(id)] as const)))

const objectFor = (
  object: LevelObject,
  materials: Map<string, Material>,
  models: Map<string, LoadedModel>,
): Object3D => {
  if (isModel(object)) return models.get(object.model.inventoryId)!.object

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
