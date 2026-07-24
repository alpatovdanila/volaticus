import { Camera, Scene } from 'three'
import {
  addComponents,
  addEntity,
  createWorld,
  entityExists,
  getEntityComponents,
  hasComponent,
  query,
  removeComponent,
  removeEntity,
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

  addEntity(...components: ComponentRef[]): EntityId {
    return addEntity(this.ecs, ...components)
  }

  removeEntity(eid: EntityId): void {
    removeEntity(this.ecs, eid)
  }

  entityExists(eid: EntityId): boolean {
    return entityExists(this.ecs, eid)
  }

  entityComponents(eid: EntityId): ComponentRef[] {
    return getEntityComponents(this.ecs, eid)
  }

  addComponent(eid: EntityId, ...components: Parameters<typeof addComponents>[2][]): void {
    addComponents(this.ecs, eid, ...components)
  }

  removeComponent(eid: EntityId, ...components: ComponentRef[]): void {
    removeComponent(this.ecs, eid, ...components)
  }

  hasComponent(eid: EntityId, component: ComponentRef): boolean {
    return hasComponent(this.ecs, eid, component)
  }

  query(terms: QueryTerm[], ...modifiers: (QueryModifier | QueryOptions)[]): QueryResult {
    return query(this.ecs, terms, ...modifiers)
  }

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
