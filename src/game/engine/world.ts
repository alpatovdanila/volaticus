import { Camera, Scene } from 'three'
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

import { createEvent } from '@shared/lib/atomic-event'
import { BaseService } from './services-registry'

/**
 * World is what is getting computed/rendered on every frame.
 * It holds ECS+shortcut ecs methods, current camera that should be rendered, current scene
 * The creation and the loading of all of these is reserved to Level service and others
 */
export class World extends BaseService {
  readyStateChange = createEvent<boolean>()
  ready = createEvent()
  readonly ecs = createWorld()
  readyState: boolean = false
  private _scene: Scene | null = null
  private _camera: Camera | null = null

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

  set camera(camera: Camera) {
    this._camera = camera
    this.emitPossibleReadiness()
  }

  set scene(scene: Scene) {
    this._scene = scene
    this.emitPossibleReadiness()
  }

  get camera(): Camera | null {
    return this._camera
  }

  get scene(): Scene | null {
    return this._scene
  }

  private emitPossibleReadiness() {
    if (this.camera && this.scene) {
      this.readyStateChange((this.readyState = true))
    } else {
      this.readyStateChange((this.readyState = false))
    }
  }
}

export type IWorld = InstanceType<typeof World>
