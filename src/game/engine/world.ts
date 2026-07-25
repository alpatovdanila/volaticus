import { Group, PerspectiveCamera, Scene } from 'three'
import {
  addComponents as ecsAddComponents,
  addEntity as ecsAddEntity,
  createWorld,
  entityExists as ecsEntityExists,
  getEntityComponents as ecsGetEntityComponents,
  hasComponent as ecsHasComponent,
  query as ecsQuery,
  removeComponent as ecsRemoveComponent,
  removeEntity as ecsRemoveEntity,
  type ComponentRef,
  type EntityId,
  type QueryModifier,
  type QueryOptions,
  type QueryResult,
  type QueryTerm,
} from 'bitecs'

import { BaseService, IServicesRegistry } from './services-registry'

/*
Everything the simulation spawns lives under worldRoot, so unloading a level clears that node
instead of the scene — the scene itself keeps whatever has to outlive a level change.
*/
class GameScene extends Scene {
  readonly worldRoot = new Group()

  constructor() {
    super()
    this.worldRoot.name = 'worldRoot'
    this.add(this.worldRoot)
  }
}

/**
 * World is what is getting computed/rendered on every frame.
 * It owns the ecs (+shortcut ecs methods), the scene and the camera — all three live as long as
 * the game does. Placing the camera and filling the scene is left to Level service and others
 */
export class World extends BaseService {
  readonly ecs = createWorld()
  readonly scene = new GameScene()
  readonly camera = new PerspectiveCamera(60, 1, 0.1, 1000)

  init(registry: IServicesRegistry) {
    registry.get('deviceScreen').aspectRatioChanged.on((aspectRatio) => {
      this.camera.aspect = aspectRatio
      this.camera.updateProjectionMatrix()
    })
  }

  // arrow properties, not methods: systems destructure these off the world
  // (`const { query } = this.world`), which would strip `this` from a prototype method

  addEntity = (...components: ComponentRef[]): EntityId => ecsAddEntity(this.ecs, ...components)

  removeEntity = (eid: EntityId): void => ecsRemoveEntity(this.ecs, eid)

  entityExists = (eid: EntityId): boolean => ecsEntityExists(this.ecs, eid)

  entityComponents = (eid: EntityId): ComponentRef[] => ecsGetEntityComponents(this.ecs, eid)

  addComponent = (eid: EntityId, ...components: Parameters<typeof ecsAddComponents>[2][]): void =>
    ecsAddComponents(this.ecs, eid, ...components)

  removeComponent = (eid: EntityId, ...components: ComponentRef[]): void =>
    ecsRemoveComponent(this.ecs, eid, ...components)

  hasComponent = (eid: EntityId, component: ComponentRef): boolean => ecsHasComponent(this.ecs, eid, component)

  query = (terms: QueryTerm[], ...modifiers: (QueryModifier | QueryOptions)[]): QueryResult =>
    ecsQuery(this.ecs, terms, ...modifiers)
}

export type IWorld = InstanceType<typeof World>
