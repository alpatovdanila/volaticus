import type * as THREE from 'three'
import { WebGPURenderer, RenderPipeline } from 'three/webgpu'
import { pass, mrt, output, normalView, rtt, vec3, vec4, float } from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js'

import { query } from 'bitecs'

import { IsCamera, ThreeObject } from './world/ecs/components'

import { TONEMAPS, type ToneMap } from '../../../lib/hdri-registry'
import { createEvent } from '../../../lib/atomic-event'

import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

/*
 GTAO — screen-space ambient occlusion. Hardcoded for now; these want to become part of the
 level's `environment` block once the values settle, next to intensity/rotation.

 radius is in VIEW-SPACE METRES, so it is tied to how big things actually are: the character is
 ~1.7m, so a radius around half a metre reads as contact shading under a chin or inside an
 elbow rather than a thin outline. `thickness` is how far behind a depth sample GTAO assumes
 the surface continues — lower values reduce the phantom occlusion that smears BEHIND objects
 as the camera moves, which is inherent to screen-space AO and tunable rather than fixable.
*/
const GTAO = {
  enabled: true,
  // these are the editor's tuned values (src/editor/viewport.ts), which were dialled in against
  // this project's actual content — preferred over a fresh guess. The character is ~1.7m, well
  // inside the 0.5-2m range they were sized for.
  radius: 0.25,
  thickness: 0.35,
  intensity: 1.0,
  // AO cost is per pixel OF ITS OWN BUFFER, so 0.5 is a quarter of the work; the denoiser
  // hides most of the softening. 1 = full res.
  resolutionScale: 1,
}

export class Renderer extends BaseService {
  private threeRenderer = new WebGPURenderer()
  private world!: KnownServices['world']
  private deviceScreen!: KnownServices['deviceScreen']

  becomeReady = createEvent()
  private animationLoopCallback = (time: number) => {}
  private post: RenderPipeline | null = null
  // kept so radius/thickness/intensity stay live uniforms — tunable without rebuilding the chain
  private aoPass: ReturnType<typeof ao> | null = null

  create() {
    this.threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    document.body.appendChild(this.threeRenderer.domElement)
  }

  setAnimationLoopCallback(cb: (time: number) => void) {
    this.animationLoopCallback = cb
  }

  init(registry: IServicesRegistry): void {
    this.deviceScreen = registry.get('deviceScreen')
    this.world = registry.get('world')
    this.deviceScreen.resolutionChanged.on((resolution) => {
      this.threeRenderer.setSize(resolution.width, resolution.height)
    })
    // the post chain closes over the scene and camera, and a level swaps both — so it can
    // only be built once a level exists, and has to be rebuilt whenever one loads
    this.world.worldReady.on(() => this.buildPostChain())
  }

  async start() {
    await this.threeRenderer.init()
    this.becomeReady()
    this.threeRenderer.setAnimationLoop((time) => this.animationLoopCallback(time))
  }

  /*
   Scene pass with MRT normals → GTAO → denoise → multiply into the colour.

   RenderPipeline keeps outputColorTransform on, so tone mapping and the output colour space
   still happen at the end of the chain exactly as they do on the direct path.
  */
  private buildPostChain() {
    this.post?.dispose()
    this.post = null
    this.aoPass = null
    if (!GTAO.enabled) return

    const scene = this.world.scene
    const camera = this.camera()
    if (!camera) return

    // samples: 0 — the pass target must NOT inherit the canvas MSAA count. Multisampling an
    // intermediate that feeds per-pixel post maths is pure bandwidth for no benefit.
    const scenePass = pass(scene, camera, { samples: 0 })
    scenePass.setMRT(mrt({ output, normal: normalView }))

    const colour = scenePass.getTextureNode('output')
    const normal = scenePass.getTextureNode('normal')
    const depth = scenePass.getTextureNode('depth')

    const aoPass = ao(depth, normal, camera)
    aoPass.radius.value = GTAO.radius
    aoPass.thickness.value = GTAO.thickness
    aoPass.scale.value = GTAO.intensity
    aoPass.resolutionScale = GTAO.resolutionScale
    this.aoPass = aoPass

    /*
     GTAO is spatially noisy per pixel; the companion denoiser is what makes it presentable.
     It renders into its OWN target at the AO buffer's resolution — inline, its 5x5 taps would
     run per FULL-RES output pixel even when the AO buffer is half size.
    */
    const denoised = rtt(denoise(aoPass.getTextureNode(), depth, normal, camera) as never)
    denoised.setResolutionScale(GTAO.resolutionScale)

    this.post = new RenderPipeline(this.threeRenderer)
    // AO rides the RED channel of its target; float() takes .x and vec3 splats it to grey
    this.post.outputNode = colour.mul(vec4(vec3(float(denoised as never)), 1)) as never
  }

  /*
   Tone mapping is compiled INTO each material as a shader define, so assigning it on the
   renderer is inert for anything already compiled — every existing material has to be flagged
   for recompile. The scene is an argument because the caller is mid-load: the level being lit
   is not yet the one on world.
  */
  setToneMapping(mode: ToneMap, scene: THREE.Scene) {
    const next = TONEMAPS[mode]
    if (this.threeRenderer.toneMapping === next) return
    this.threeRenderer.toneMapping = next

    scene.traverse((object) => {
      const material = (object as THREE.Mesh).material
      if (!material) return
      for (const entry of Array.isArray(material) ? material : [material]) entry.needsUpdate = true
    })
  }

  update() {
    if (this.post) return this.post.render()
    const camera = this.camera()
    if (camera) this.threeRenderer.render(this.world.scene, camera)
  }

  private camera(): THREE.PerspectiveCamera | undefined {
    const eid = query(this.world.ecs, [IsCamera, ThreeObject])[0]
    return eid === undefined ? undefined : (ThreeObject[eid] as THREE.PerspectiveCamera)
  }

  getThreeRenderer() {
    return this.threeRenderer
  }
}

export type IRenderer = InstanceType<typeof Renderer>
