import { LoadingManager } from 'three'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { WebGPURenderer } from 'three/webgpu'

import { HdriLoader } from './loaders/hdri-loader'
import { JsonLoader } from './loaders/json-loader'
import { MaterialLoader } from './loaders/material-loader'
import { ModelLoader } from './loaders/model-loader'
import { BaseService, IServicesRegistry } from './services-registry'

const TRANSCODER = '/node_modules/three/examples/jsm/libs/basis/'

/*
One LoadingManager and one KTX2Loader behind every loader: progress and errors are accounted for
in one place, and there is a single transcoder worker pool no matter how many loaders exist.

ktx2 transcodes to whatever compressed formats the DEVICE supports, so detectSupport needs an
initialised renderer. gpuReady is that moment, handed to the loaders that transcode — held as a
promise so a load arriving before the renderer is up waits instead of racing.
*/
export class Loader extends BaseService {
  readonly manager = new LoadingManager()
  readonly ktx2 = new KTX2Loader(this.manager).setTranscoderPath(TRANSCODER)

  private readonly gpuReady = Promise.withResolvers<WebGPURenderer>()

  readonly json = new JsonLoader(this.manager)
  readonly material = new MaterialLoader(this.manager, this.json, this.ktx2, this.gpuReady.promise)
  readonly hdri = new HdriLoader(this.json, this.ktx2, this.gpuReady.promise)
  readonly model = new ModelLoader(this.manager, this.json, this.ktx2, this.gpuReady.promise)

  init(registry: IServicesRegistry) {
    const renderer = registry.get('renderer')

    renderer.becomeReady.on(() => {
      this.ktx2.detectSupport(renderer.webGPURenderer)
      this.gpuReady.resolve(renderer.webGPURenderer)
    })
  }
}

export type ILoader = InstanceType<typeof Loader>
