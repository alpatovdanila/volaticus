import { CompressedTexture, LinearFilter, LinearMipmapLinearFilter, LoadingManager } from 'three'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { WebGPURenderer } from 'three/webgpu'

import { HdriLoader } from './loaders/hdri-loader'
import { JsonLoader } from './loaders/json-loader'
import { MaterialLoader } from './loaders/material-loader'
import { ModelLoader } from './loaders/model-loader'
import { BaseService, IServicesRegistry } from './services-registry'

/*
Vendored into resources/basis rather than left to KTX2Loader's own default.

Its default resolves `../libs/basis/` off the loader module's import.meta.url, which is correct in
a build but points inside vite's pre-bundled deps in dev — where the file does not exist and the
dev server answers with the SPA fallback: a 200 of text/html. The transcoder then never
initialises and every ktx2 decode hangs forever rather than failing, which reads as a level that
silently never finishes loading.

publicDir serves this at /basis/ in dev and the build copies the same folder, so one path is
right in both.
*/
const TRANSCODER = `${import.meta.env.BASE_URL}basis/`

// the level array is typed as dense, which is precisely the assumption that breaks below
type Level = { width: number; height: number }
type Mipped = Omit<CompressedTexture, 'mipmaps'> & { mipmaps?: (Level | undefined)[] }

/*
Drops a transcoded mip chain at its first missing level.

Not every device can take every format basis transcodes to, and a level that does not come back
leaves a hole in texture.mipmaps. three's webgpu backend walks that array unconditionally —
`_copyCompressedBufferToTexture` reads `.width` off the hole and the tab dies mid-frame, nowhere
near the loader that produced it.

The levels above a hole are still good, so we keep them and stop there. A hole at level 0 leaves
nothing to keep: that texture renders wrong, which beats taking the page down.
*/
const repairMips = (texture: Mipped): Mipped => {
  const mipmaps = texture.mipmaps
  if (!mipmaps?.length) return texture

  const hole = mipmaps.findIndex((level) => level === undefined || level.width === undefined)
  if (hole === -1) return texture

  console.warn(`ktx2: level ${hole} of ${mipmaps.length} did not transcode on this device — dropping it and below`)

  texture.mipmaps = mipmaps.slice(0, hole)
  texture.minFilter = texture.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/*
Every ktx2 in the app arrives through this one `load`: GLTFLoader reaches the shared instance for
glb-embedded textures (loadImageSource calls loader.load) and HdriLoader through loadAsync, which
wraps the same method. One patch covers both rather than each loader remembering to sanitise.
*/
const repairing = (loader: KTX2Loader): KTX2Loader => {
  const load = loader.load.bind(loader)
  loader.load = (url, onLoad, onProgress, onError) =>
    load(url, (texture) => onLoad(repairMips(texture as unknown as Mipped) as unknown as CompressedTexture), onProgress, onError)
  return loader
}

/*
One LoadingManager and one KTX2Loader behind every loader: progress and errors are accounted for
in one place, and there is a single transcoder worker pool no matter how many loaders exist.

ktx2 transcodes to whatever compressed formats the DEVICE supports, so detectSupport needs an
initialised renderer. gpuReady is that moment, handed to the loaders that transcode — held as a
promise so a load arriving before the renderer is up waits instead of racing.
*/
export class Loader extends BaseService {
  readonly manager = new LoadingManager()
  readonly ktx2 = repairing(new KTX2Loader(this.manager).setTranscoderPath(TRANSCODER))

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
