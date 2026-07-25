import { BoxGeometry, Mesh, MeshNormalMaterial, PlaneGeometry } from 'three'

import { IsPlayer, IsSolid, NeedsSpawn, Position, Rotation, SceneObject, writeVec3Row } from '@components'
import { Behaviour, LevelObject, parseLevelDeclaration } from '@lib/level.schema'
import { BaseService, IServicesRegistry, KnownServices } from './services-registry'

const BEHAVIOUR_TAGS: Record<Behaviour, object> = {
  player: IsPlayer,
  solid: IsSolid,
}

const levelUrl = (name: string) => `/src/game/levels/${name}.json`

/*
Turns a level declaration into entities. WHICH level to load is the caller's call — this
service only knows how to fetch, validate and spawn one.

PLACEHOLDER VISUALS: inventoryIds are validated but not resolved — materials, models and the
hdri environment are stand-ins until those loaders exist.
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
    for (const object of level.objects) this.spawn(object)
  }

  private spawn(object: LevelObject) {
    const eid = this.world.addEntity(Position, Rotation, SceneObject, NeedsSpawn)

    SceneObject[eid] = placeholderFor(object)
    writeVec3Row(Position, eid, object.position)
    writeVec3Row(Rotation, eid, object.rotation)

    for (const behaviour of object.behaviour) this.world.addComponent(eid, BEHAVIOUR_TAGS[behaviour])
  }
}

const placeholderFor = (object: LevelObject): Mesh => {
  if (object.type === 'model') return new Mesh(new BoxGeometry(0.6, 1.8, 0.4), new MeshNormalMaterial())

  const [width, height] = object.primitive.size
  return new Mesh(new PlaneGeometry(width, height), new MeshNormalMaterial())
}

export type ILevel = InstanceType<typeof Level>
