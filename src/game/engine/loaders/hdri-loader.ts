import { EquirectangularReflectionMapping, LinearFilter, Texture } from 'three'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { WebGPURenderer } from 'three/webgpu'

import { parseHdriDeclaration } from '@inventory/schemas/hdri.schema'
import { JsonLoader } from './json-loader'

const HDRI = `${import.meta.env.BASE_URL}inventory/items/hdri`

/*
Resolves an inventory hdri id to an equirect environment texture. The item doc is a pointer —
the payload is a UASTC HDR ktx2 beside it, which transcodes to BC6H on this device.

The catalog stores equirects bottom-up to match three's equirectUv, and KTX2Loader serves rows
as stored, so nothing here flips anything. Textures are SHARED, one per id; nothing disposes.
*/
export class HdriLoader {
  private cache = new Map<string, Promise<Texture>>()

  constructor(
    private json: JsonLoader,
    private ktx2: KTX2Loader,
    private gpuReady: Promise<WebGPURenderer>,
  ) {}

  load(inventoryId: string): Promise<Texture> {
    const cached = this.cache.get(inventoryId)
    if (cached) return cached

    const pending = this.read(inventoryId)
    this.cache.set(inventoryId, pending)
    pending.catch(() => this.cache.delete(inventoryId))
    return pending
  }

  private async read(inventoryId: string): Promise<Texture> {
    await this.gpuReady

    const dir = `${HDRI}/${inventoryId}`
    const doc = parseHdriDeclaration(inventoryId, await this.json.load(`${dir}/${inventoryId}.json`))
    const texture = await this.ktx2.loadAsync(`${dir}/${doc.file}`)

    texture.mapping = EquirectangularReflectionMapping

    /*
    Only the full-size level is kept.

    An hdri is a prefilter source and nothing else — PMREMGenerator builds its own roughness chain
    from level 0, so the ten smaller compressed levels below it are uploaded for no one. They are
    not free: this is UASTC HDR, a format most mobile gpus cannot take natively, and a level that
    fails to come back from the transcoder is an undefined entry that the webgpu backend walks
    straight into (`_copyCompressedBufferToTexture` reads .width off it and the tab dies).

    Fewer levels is less to go wrong, and costs nothing we use.
    */
    const levels = texture.mipmaps?.length ?? 0
    if (levels > 1) {
      texture.mipmaps = texture.mipmaps!.slice(0, 1)
      texture.minFilter = LinearFilter
      texture.generateMipmaps = false
      texture.needsUpdate = true
    }

    // one line, kept in production on purpose: this texture is the one that breaks on devices we
    // cannot attach a debugger to, and its format is the first thing worth knowing
    console.info(`hdri '${inventoryId}': ${texture.image?.width}x${texture.image?.height}, ${levels} level(s)`)

    return texture
  }
}
