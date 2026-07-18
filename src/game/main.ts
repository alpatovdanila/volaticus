import { scopeHmrReloads } from '../lib/hmr-scope'
import devLevel from './levels/dev.json'
import { ServicesRegistry } from './engine/services-registry'
import { DeviceScreen } from './engine/services/device-screen'
import { Renderer } from './engine/services/renderer'

import { SceneSpawn } from './engine/services/scene-spawn'
import { Inventory } from './engine/services/inventory'
import { World } from './engine/services/world/world'
import { parseLevelDeclaration } from './engine/services/world/level-schema'
import { Input } from './engine/services/input'
import { PlayerControl } from './engine/services/player-control'
import { Movement } from './engine/services/movement'
import { Animation } from './engine/services/animation'
import { TransformSync } from './engine/services/transform-sync'
import { DebugOverlay } from './engine/services/debug-overlay'

scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/'])

const engine = new ServicesRegistry()

/*
 Registration order IS update order, and it matters:
 read input, act on it, integrate, animate, then push the result at three.js and draw.
*/
engine.register('deviceScreen', new DeviceScreen())
engine.register('input', new Input())
engine.register('inventory', new Inventory())
const world = engine.register('world', new World())
engine.register('playerControl', new PlayerControl())
engine.register('movement', new Movement())
engine.register('animation', new Animation())
engine.register('sceneSpawn', new SceneSpawn())
engine.register('transformSync', new TransformSync())
engine.register('renderer', new Renderer())
// last: it reports on the frame everything else just produced
engine.register('debugOverlay', new DebugOverlay())

await engine.start()
await world.loadLevel(parseLevelDeclaration(devLevel))

if (import.meta.env.DEV) (window as any).__engine = engine
