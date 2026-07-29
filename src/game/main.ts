import { ServicesRegistry } from '@engine/services-registry'
import { scopeHmrReloads } from '@shared/lib/hmr-scope'
import { DeviceScreen } from '@engine/device-screen'
import { ThreeSceneSync } from '@systems/three-scene-sync'
import { Movement } from '@systems/movement'
import { ThreeAnimatorSync } from '@systems/three-animator-sync'
import { LocomotionAnimation } from '@systems/locomotion-animation'
import { PlayerControls } from '@systems/player-controls'
import { CameraFollow } from '@systems/camera-follow'
import { Input } from '@engine/input'
import { Destroy } from '@systems/destroy'
import { Renderer } from '@engine/renderer'
import { World } from '@engine/world'
import { Loader } from '@engine/loader'
import { DevOverlay } from '@engine/dev-overlay'
import { Level } from '@engine/level'

scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/', 'inventory/'])

const engine = new ServicesRegistry()

/**
 * Engine services
 */
engine.register('deviceScreen', new DeviceScreen())
engine.register('input', new Input())
engine.register('world', new World())
engine.register('loader', new Loader())
const level = engine.register('level', new Level())
engine.register('renderer', new Renderer())

/**
 * Ecs systems — update order is registration order: threeSceneSync publishes whatever the
 * systems above wrote this frame, destroy tears down last so everything else saw the entity
 */
engine.register('playerControls', new PlayerControls())
engine.register('movement', new Movement())
engine.register('cameraFollow', new CameraFollow())
engine.register('locomotionAnimation', new LocomotionAnimation())
engine.register('threeAnimatorSync', new ThreeAnimatorSync())
engine.register('threeSceneSync', new ThreeSceneSync())
engine.register('destroy', new Destroy())

// last, so its readout covers every other service's work this frame
engine.register('devOverlay', new DevOverlay())

await engine.start()

await level.load('dev')
