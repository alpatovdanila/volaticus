import { addComponent, addEntity, createWorld as createEcsWorld, observe, onAdd, onRemove, onSet } from 'bitecs'
import { PerspectiveCamera, Scene } from 'three'
import { createEvent } from '../../../../lib/atomic-event'
import { BaseService, IServicesRegistry, KnownServices } from '../../services-registry'

import { LevelDeclaration } from './level-schema'
import { LevelLoader } from './level-loader'
import { EnvironmentLoader } from './environment-loader'
import { AnimatorTask, IsAnimatorFree, IsCamera, Position, Rotation, ThreeObject, writeVec3Row } from './ecs/components'

const CAMERA_FOV = 48
const CAMERA_NEAR = 0.1
const CAMERA_FAR = 200

export class World extends BaseService {
  private inventory!: KnownServices['inventory']
  private renderer!: KnownServices['renderer']
  worldReady = createEvent()

  readonly ecs = createEcsWorld()
  scene: Scene = new Scene() // dummy starting scene

  init(registry: IServicesRegistry): void {
    this.inventory = registry.get('inventory')
    this.renderer = registry.get('renderer')

    const camera = new PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR)
    const eid = addEntity(this.ecs)
    addComponent(this.ecs, eid, Position)
    addComponent(this.ecs, eid, Rotation)
    addComponent(this.ecs, eid, ThreeObject)
    addComponent(this.ecs, eid, IsCamera)
    ThreeObject[eid] = camera
    writeVec3Row(Position, eid, [0, 0, 0])
    writeVec3Row(Rotation, eid, [0, 0, 0])

    const screen = registry.get('deviceScreen')
    screen.aspectRatioChanged.on((aspect) => {
      camera.aspect = aspect
      camera.updateProjectionMatrix()
    })

    observe(this.ecs, onAdd(IsAnimatorFree), () => console.log('free'))
    observe(this.ecs, onRemove(IsAnimatorFree), () => console.log('not free'))
  }

  async loadLevel(levelDeclaration: LevelDeclaration) {
    const levelLoader = new LevelLoader(levelDeclaration, this.inventory)
    const environmentLoader = new EnvironmentLoader(levelDeclaration, this.renderer)

    this.scene = await levelLoader.loadAndBuild(this.ecs)
    await environmentLoader.loadAndAttach(this.scene)

    this.worldReady()
  }
}

export type IWorld = InstanceType<typeof World>
