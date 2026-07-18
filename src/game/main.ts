import { scopeHmrReloads } from '../lib/hmr-scope'
import devLevel from './levels/dev.json'
import { ServicesRegistry } from './engine/services-registry'
import { DeviceScreen } from './engine/services/device-screen'
import { Renderer } from './engine/services/renderer'

import { SceneSpawn } from './engine/services/scene-spawn'
import { Inventory } from './engine/services/inventory'
import { World } from './engine/services/world/world'
import { parseLevelDeclaration } from './engine/services/world/level-schema'

scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/'])

const engine = new ServicesRegistry()

// Services would be updated  in that order. One common loop for now
engine.register('deviceScreen', new DeviceScreen())
engine.register('renderer', new Renderer())
engine.register('inventory', new Inventory())
engine.register('sceneSpawn', new SceneSpawn())
const world = engine.register('world', new World())

await engine.start()
await world.loadLevel(parseLevelDeclaration(devLevel))
