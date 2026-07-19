import { scopeHmrReloads } from '../lib/hmr-scope'
import devLevel from './levels/dev.json'
import { ServicesRegistry } from './engine/services-registry'
import { DeviceScreen } from './engine/services/device-screen'
import { Renderer } from './engine/services/renderer'

import { Inventory } from './engine/services/inventory'
import { World } from './engine/services/world/world'
import { parseLevelDeclaration } from './engine/services/world/level-schema'
import { Input } from './engine/services/input'
import { PlayerControl } from './engine/services/player-control'
import { Movement } from './engine/services/movement'
import { AnimationsDriver } from './engine/services/animations-driver'

import { ThreeSceneSync } from './engine/services/three-scene-sync'
import { DebugOverlay } from './engine/services/debug-overlay'
import { CameraControl } from './engine/services/camera-control'
import { LocomotionAnimation } from './engine/services/locomotion-animation/locomotion-animation'

scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/'])

const engine = new ServicesRegistry()

engine.register('deviceScreen', new DeviceScreen())
engine.register('input', new Input())
engine.register('inventory', new Inventory())
const world = engine.register('world', new World())
engine.register('playerControl', new PlayerControl())
engine.register('movement', new Movement())
engine.register('locomotionAnimation', new LocomotionAnimation())
engine.register('animation', new AnimationsDriver())
engine.register('cameraControl', new CameraControl())
engine.register('threeSceneSync', new ThreeSceneSync())
engine.register('renderer', new Renderer())
engine.register('debugOverlay', new DebugOverlay())

await engine.start()
await world.loadLevel(parseLevelDeclaration(devLevel))

if (import.meta.env.DEV) (window as any).__engine = engine
