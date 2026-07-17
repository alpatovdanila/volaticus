
import { scopeHmrReloads } from '../lib/hmr-scope'

import {EngineSystemsRegistry} from "./services/engine-systems-registry";
import {DeviceScreen} from "./services/device-screen";
import {Renderer} from "./services/renderer";
import {CameraManager} from "./services/camera-manager";
import {Inventory} from "./services/inventory";
import {Levels} from "./services/levels/levels";

scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/'])

const engine = new EngineSystemsRegistry()

engine.register('deviceScreen', new DeviceScreen())
engine.register('renderer', new Renderer())
engine.register('cameraManager', new CameraManager())
engine.register('inventory', new Inventory())
engine.register('levels', new Levels())


await engine.start()

