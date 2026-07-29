import { ServicesRegistry } from '@engine/services-registry'
import { scopeHmrReloads } from '@shared/lib/hmr-scope'
import { DeviceScreen } from '@engine/device-screen'
import { ThreeSceneSync } from '@systems/three-scene-sync'
import { Movement } from '@systems/movement'
import { ThreeAnimatorSync } from '@systems/three-animator-sync'
import { InstancedSkinSync } from '@systems/instanced-skin-sync'
import { LocomotionAnimation } from '@systems/locomotion-animation'
import { EnemySteering } from '@systems/enemy-steering'
import { EnemyLifecycle } from '@systems/enemy-lifecycle'
import { Shooting } from '@systems/shooting'
import { Projectiles } from '@systems/projectiles'
import { Limbs } from '@systems/limbs'
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
// after controls: aiming overrides the facing the stick just wrote
engine.register('shooting', new Shooting())
engine.register('enemySteering', new EnemySteering())
engine.register('movement', new Movement())
// after movement: collisions test where things are this frame, not where they were
engine.register('projectiles', new Projectiles())
// after the hits that create them, so a limb gets its first transform on the frame it is thrown
engine.register('limbs', new Limbs())
engine.register('cameraFollow', new CameraFollow())
engine.register('locomotionAnimation', new LocomotionAnimation())
engine.register('threeAnimatorSync', new ThreeAnimatorSync())
engine.register('instancedSkinSync', new InstancedSkinSync())
engine.register('threeSceneSync', new ThreeSceneSync())
// after the syncs: it reacts to a death clip having finished, which the sync decides this frame
engine.register('enemyLifecycle', new EnemyLifecycle())
engine.register('destroy', new Destroy())

// last, so its readout covers every other service's work this frame
engine.register('devOverlay', new DevOverlay())

await engine.start()

await level.load('dev')
