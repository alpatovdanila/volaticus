import { ServicesRegistry } from '@engine/services-registry'
import { scopeHmrReloads } from '@shared/lib/hmr-scope'
import { DeviceScreen } from '@engine/device-screen'
import { ThreeSceneSync } from '@systems/three-scene-sync'
import { Movement } from '@systems/movement'
import { Destroy } from '@systems/destroy'
import { Renderer } from '@engine/renderer'
import { World } from '@engine/world'
import { Level } from '@engine/level'

scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/'])

const engine = new ServicesRegistry()

/**
 * Engine services
 */
engine.register('deviceScreen', new DeviceScreen())
engine.register('world', new World())
engine.register('level', new Level())
engine.register('renderer', new Renderer())

/**
 * Ecs systems — update order is registration order: threeSceneSync publishes whatever the
 * systems above wrote this frame, destroy tears down last so everything else saw the entity
 */
engine.register('movement', new Movement())
engine.register('threeSceneSync', new ThreeSceneSync())
engine.register('destroy', new Destroy())

await engine.start()
