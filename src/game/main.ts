import { ServicesRegistry } from '@engine/services-registry'
import { scopeHmrReloads } from '@shared/lib/hmr-scope'
import { DeviceScreen } from '@engine/device-screen'
import { ThreeSceneSync } from '@systems/three-scene-sync'
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
 * Ecs systems
 */
engine.register('threeSceneSync', new ThreeSceneSync())

await engine.start()
