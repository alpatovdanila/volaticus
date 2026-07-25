import { LoadingManager } from 'three'

import { JsonLoader } from './loaders/json-loader'
import { MaterialLoader } from './loaders/material-loader'
import { BaseService, IServicesRegistry } from './services-registry'

/*
One LoadingManager behind every loader, so progress and errors are accounted for in one place
no matter who started the fetch. GLTFLoader and KTX2Loader take a manager the same way when
the material and model loaders land.
*/
export class Loader extends BaseService {
  readonly manager = new LoadingManager()

  readonly json = new JsonLoader(this.manager)

  readonly material = new MaterialLoader(this.manager, this.json)

  init(registry: IServicesRegistry) {
    this.material.init(registry.get('renderer'))
  }
}

export type ILoader = InstanceType<typeof Loader>
