import { WebGPURenderer } from 'three/webgpu'
import { EventEmitter } from '../lib/event-emitter'
import {IDeviceScreen, IEngineSystemsRegistry, ILevels} from "./interfaces";
import {Timer} from "three";
import {EngineSystem} from "./base-engine-system";


export class Renderer extends EngineSystem{
  private threeRenderer = new WebGPURenderer({ antialias: true })
  private levels!: ILevels
  private deviceScreen!: IDeviceScreen
  private emitter = new EventEmitter()

  create(){
    this.threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    document.body.appendChild(this.threeRenderer.domElement)
  }

  init(registry: IEngineSystemsRegistry): void{
    this.deviceScreen = registry.get<IDeviceScreen>('deviceScreen')
    this.levels = registry.get<ILevels>('levels')
    this.deviceScreen.onResolutionChanged((resolution)=>{
      this.threeRenderer.setSize(resolution.width, resolution.height)
    })
  }

  async start(){
    await this.threeRenderer.init()

    this.emitter.emit('ready')

    const timer = new Timer()

    timer.connect(document)

    const frame = (timestamp: number): void => {
      timer.update(timestamp) // advance ONCE per step, before any read
      const dt = Math.min(0.05, timer.getDelta()) // Timer has no clamp; a stall must not teleport the world

      this.threeRenderer.render(this.levels.getActive().getScene(), this.levels.getActive().getCamera())

      requestAnimationFrame(frame)
    }

    requestAnimationFrame(frame)



  }

  onReady(handler:VoidFunction){
    this.emitter.on('ready', handler)
  }


  getThreeRenderer(): WebGPURenderer {
    return this.threeRenderer
  }
}

export type IRenderer = InstanceType<typeof Renderer>;
