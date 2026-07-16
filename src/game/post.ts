// Post chain for the game — the editor viewport's GTAO + tilt-shift recipe, self-
// contained (the editor stays untouched). Direct render when both effects are off;
// (re)builds the RenderPipeline on toggle; strengths are live uniforms.
import * as THREE from 'three'
import { WebGPURenderer, RenderPipeline } from 'three/webgpu'
import { vec2, vec3, vec4, float, pass, mrt, output, normalView, rtt, screenUV, uniform, mix, smoothstep } from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'

export class PostChain {
  private post: RenderPipeline | null = null
  private gtao: ReturnType<typeof ao> | null = null
  private gtaoDenoiseRtt: ReturnType<typeof rtt> | null = null
  private gtaoOn = false
  private tiltOn = false
  private gtaoStrength = 1
  private gtaoRes = 1
  private tiltStrengthU = uniform(0.5)

  constructor(
    private renderer: WebGPURenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {}

  setGtao(on: boolean): void {
    if (on === this.gtaoOn) return
    this.gtaoOn = on
    this.rebuild()
  }

  setTiltShift(on: boolean): void {
    if (on === this.tiltOn) return
    this.tiltOn = on
    this.rebuild()
  }

  setGtaoStrength(v: number): void {
    this.gtaoStrength = Math.max(0, Math.min(3, v))
    if (this.gtao) this.gtao.scale.value = this.gtaoStrength
  }

  setGtaoResolution(scale: number): void {
    this.gtaoRes = Math.max(0.25, Math.min(1, scale))
    if (this.gtao) this.gtao.resolutionScale = this.gtaoRes
    this.gtaoDenoiseRtt?.setResolutionScale(this.gtaoRes)
  }

  setTiltShiftStrength(v: number): void {
    this.tiltStrengthU.value = Math.max(0, Math.min(1, v))
  }

  active(): boolean {
    return this.post !== null
  }

  // render through the chain when active; false = caller renders directly
  render(): boolean {
    if (!this.post) return false
    this.post.render()
    return true
  }

  private rebuild(): void {
    this.post?.dispose()
    this.post = null
    this.gtao = null
    this.gtaoDenoiseRtt = null
    if (!this.gtaoOn && !this.tiltOn) return
    // samples: 0 — never inherit canvas MSAA into per-pixel post math (bandwidth)
    const scenePass = pass(this.scene, this.camera, { samples: 0 })
    let color: unknown
    if (this.gtaoOn) {
      scenePass.setMRT(mrt({ output, normal: normalView }))
      const scenePassColor = scenePass.getTextureNode('output')
      const scenePassNormal = scenePass.getTextureNode('normal')
      const scenePassDepth = scenePass.getTextureNode('depth')
      const aoPass = ao(scenePassDepth, scenePassNormal, this.camera)
      aoPass.radius.value = 0.25
      aoPass.thickness.value = 0.35
      aoPass.scale.value = this.gtaoStrength
      aoPass.resolutionScale = this.gtaoRes
      this.gtao = aoPass
      const denoised = rtt(denoise(aoPass.getTextureNode(), scenePassDepth, scenePassNormal, this.camera) as never)
      denoised.setResolutionScale(this.gtaoRes)
      this.gtaoDenoiseRtt = denoised
      color = scenePassColor.mul(vec4(vec3(float(denoised as never)), 1))
    } else {
      color = scenePass.getTextureNode('output')
    }
    if (this.tiltOn) {
      const sharp = this.gtaoOn ? rtt(color as never) : (color as ReturnType<typeof rtt>)
      const blurred = gaussianBlur(sharp as never, vec2(this.tiltStrengthU, this.tiltStrengthU).mul(2) as never, 6, {
        resolutionScale: 0.5,
      })
      // force half-float internals or the HDR scene clips inside the blur
      const b = blurred as unknown as { _horizontalRT: THREE.RenderTarget; _verticalRT: THREE.RenderTarget }
      b._horizontalRT.texture.type = THREE.HalfFloatType
      b._verticalRT.texture.type = THREE.HalfFloatType
      const band = smoothstep(float(0.12), float(0.45), screenUV.y.sub(0.5).abs())
      color = mix(sharp as never, blurred as never, band as never)
    }
    this.post = new RenderPipeline(this.renderer)
    this.post.outputNode = color as never
  }
}
