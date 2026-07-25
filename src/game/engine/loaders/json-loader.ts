import { FileLoader, LoadingManager } from 'three'

/*
Loads a json document through the shared LoadingManager, so every fetch lands in the same
progress accounting. Hands back the raw payload — validating it belongs to whoever asked,
which is what keeps this loader indifferent to the shape of what it fetches.

Not three's ObjectLoader: that parses three's own scene serialization (metadata/geometries/
materials/object) into an Object3D, and refuses anything without a `metadata` field.
*/
export class JsonLoader {
  private file: FileLoader

  constructor(manager: LoadingManager) {
    this.file = new FileLoader(manager)
    this.file.setResponseType('json')
  }

  load(url: string): Promise<unknown> {
    return this.file.loadAsync(url)
  }
}
