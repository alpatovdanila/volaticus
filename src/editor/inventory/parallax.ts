// Parallax occlusion mapping (POM) for the WebGPU/TSL pipeline. Ported from the
// three.js-Blocks `parallaxOcclusion` node — the reference native-TSL POM — adapted to
// this codebase: textureless interleaved-gradient-noise jitter (no blue-noise texture),
// 8-bit height maps whose values sit in a compressed band (normalized via hMin/hMax),
// and LIVE uniforms for quality + per-material depth/band. Only the global ON/OFF is
// build-time (materials.ts builds this node only when POM is enabled — that keeps "off"
// gray-free and free of any march), while quality (`samplesU`) and each material's depth
// and value band are runtime uniforms: drag a slider, write `.value`, done — no recompile.
//
// Quality note: TSL bakes loop BOUNDS at compile time, so the coarse march runs a FIXED
// `Loop(MAX_STEPS)` and `samplesU` drives the per-step SIZE + early-out — that's what lets
// the quality slider apply live instead of freezing (a uniform can't be a loop bound).
//
// Algorithm (canonical POM — LearnOpenGL / Tatarchuk / three.js-Blocks):
//   sweep  = -(V.xy / V.z) · heightScale · (0.2 + 0.8·cos²θ)
//            V = three's RAW parallaxDirection. Do NOT normalize it: with an orthonormal
//            TBN it is already unit, and its .z IS cos θ — the tan slope V.xy/V.z needs
//            that. The (0.2 + 0.8·cos²θ) damp holds perceived depth constant toward grazing.
//   march  = coarse front-to-back walk with an angle-adaptive layer count (8 head-on → the
//            quality setting at grazing), start depth jittered per pixel (IGN) to kill banding.
//   refine = 5 binary-search halvings of the crossing bracket — smooth, terrace-free hits.
import * as THREE from 'three'
import { Fn, If, Loop, Break, uv, texture, float, uniform, parallaxDirection, dFdx, dFdy, screenCoordinate } from 'three/tsl'

// Fixed compile-time cap on marching iterations (quality drives step SIZE at runtime, not the bound).
const MAX_STEPS = 64

// loose alias for the value returned as a uv node (what texture() accepts as its coord).
type N = ReturnType<typeof uv>

// A live scalar uniform: a TSL node usable in the graph AND carrying a settable `.value`.
export type Uniform = { value: number }

// Self-consistent loose fluent-node type. TSL's published generics are stricter/narrower than
// the runtime chaining API (per-channel swizzles, mixed-type math), so we cast nodes through
// this to build the graph without fighting the type checker. Runtime behaviour is unchanged.
interface Fl {
  readonly x: Fl
  readonly y: Fl
  readonly xy: Fl
  readonly z: Fl
  readonly r: Fl
  sub(x: Fl | number): Fl
  add(x: Fl | number): Fl
  mul(x: Fl | number): Fl
  div(x: Fl | number): Fl
  max(x: Fl | number): Fl
  min(x: Fl | number): Fl
  clamp(a: number, b: number): Fl
  reciprocal(): Fl
  negate(): Fl
  oneMinus(): Fl
  fract(): Fl
  toVar(): Fl
  assign(x: Fl): void
  addAssign(x: Fl): void
  lessThan(x: Fl): Fl
  greaterThan(x: Fl | number): Fl
  greaterThanEqual(x: Fl): Fl
}
const fl = (n: unknown): Fl => n as Fl

// Global parallax state. `enabled` is BUILD-TIME (materials.ts gates the node on it — 'off' compiles
// plain PBR, no march, no gray); `samplesU` is a LIVE uniform so the quality slider applies without a
// recompile. Create scalar per-material uniforms (depth, band) via makeUniform.
let enabled = false
const samplesU = uniform(24)
export function setParallaxConfig(cfg: { enabled?: boolean; samples?: number }): void {
  if (cfg.enabled !== undefined) enabled = cfg.enabled
  if (cfg.samples !== undefined) samplesU.value = Math.max(4, Math.min(64, Math.round(cfg.samples)))
}
export function isParallaxEnabled(): boolean {
  return enabled
}
export function getParallaxSamples(): number {
  return samplesU.value
}
// A live scalar uniform for a per-material parallax value (depth, hMin, hMax). Edit `.value` to update
// the render with no rebuild.
export function makeUniform(value: number): Uniform {
  return uniform(value) as unknown as Uniform
}

// Build the parallax-offset UV node for a material. Feed the result as the uv to every map sample so
// they stay aligned. Only called when parallax is globally ON (materials.ts gates it); the march always
// runs. `heightU` = per-material depth, `hMinU`/`hMaxU` = the map's value band (these PBR maps use a
// compressed range, e.g. 0.43–0.73), normalized to [0,1] so the map's own max sits at the surface —
// all three are LIVE uniforms. Quality is the global `samplesU` uniform.
export function parallaxUvNode(heightMap: THREE.Texture, heightU: Uniform, hMinU: Uniform, hMaxU: Uniform): N {
  const hs = fl(heightU)
  const hMin = fl(hMinU)
  const hMax = fl(hMaxU)
  return Fn(() => {
    // Screen-space gradients of the BASE uv, pinned to vars: every height tap uses these via .grad()
    // (implicit derivatives are illegal in the loop's non-uniform control flow), one stable mip across it.
    const gdx = fl(dFdx(uv())).toVar()
    const gdy = fl(dFdy(uv())).toVar()
    // Normalized height in [0,1] over the map's value band. STANDARD polarity: white = high ground, so
    // surface depth below the top face is its complement (1 − height).
    const heightAt = (u: Fl): Fl =>
      fl(texture(heightMap, u as never).grad(gdx as never, gdy as never) as never)
        .r.sub(hMin)
        .div(hMax.sub(hMin).max(fl(float(0.01))))
        .clamp(0, 1)

    const result = fl(uv()).toVar()
    const V = fl(parallaxDirection) // RAW — .z is cosθ; see header
    const nz = V.z.clamp(0.15, 1) // floor keeps the tan slope bounded at extreme grazing
    const cos2 = nz.mul(nz)
    const atten = fl(float(0.2)).add(cos2.mul(0.8)) // grazing damp — constant perceived depth
    const sweep = V.xy.div(nz).mul(hs).mul(atten).negate() // uv − direction·scale (canonical)

    // Angle-adaptive coarse layer count: 8 head-on → the LIVE `samplesU` at grazing. The Loop bound is
    // the FIXED MAX_STEPS; samplesU drives dD (step size), so quality applies at runtime, not compile time.
    const maxL = fl(samplesU).clamp(8, 64)
    const layersF = maxL.sub(maxL.sub(fl(float(8))).mul(cos2)) // = mix(samplesU, 8, cos²θ)
    const dD = layersF.reciprocal()

    // Per-pixel interleaved gradient noise (Jimenez) jitters the march start by up to one layer —
    // decorrelates the coarse layers so they can't band into iso-depth contours.
    const sc = fl(screenCoordinate)
    const jitter = sc.x.mul(0.06711056).add(sc.y.mul(0.00583715)).fract().mul(52.9829189).fract()

    const d = fl(jitter.mul(dD)).toVar()
    const curUV = fl(uv()).add(sweep.mul(d)).toVar()
    const surfD = fl(float(1)).toVar()
    const hit = fl(float(0)).toVar()
    const dPrev = fl(float(0)).toVar()
    const dHit = fl(float(1)).toVar()

    // Coarse march: fixed MAX_STEPS bound; Break() exits outright once hit, or once the
    // ray has swept past depth 1 — the loop tail costs nothing (Continue() used to keep
    // every fragment iterating all MAX_STEPS with only the body guarded).
    Loop(MAX_STEPS, () => {
      If(hit.greaterThan(0.5) as never, () => {
        Break()
      })
      If(d.greaterThan(1) as never, () => {
        Break()
      })
      surfD.assign(heightAt(curUV).oneMinus())
      If(d.greaterThanEqual(surfD) as never, () => {
        hit.assign(fl(float(1)))
        dHit.assign(d)
      }).Else(() => {
        dPrev.assign(d)
        d.addAssign(dD)
        curUV.assign(fl(uv()).add(sweep.mul(d)))
      })
    })

    If(hit.greaterThan(0.5) as never, () => {
      // Binary refinement: 5 halvings of [dPrev, dHit] — crossing lands within dD/32 of the surface.
      Loop(5, () => {
        const mid = dPrev.add(dHit).mul(0.5).toVar()
        const uvm = fl(uv()).add(sweep.mul(mid)).toVar()
        If(mid.greaterThanEqual(heightAt(uvm).oneMinus()) as never, () => {
          dHit.assign(mid)
        }).Else(() => {
          dPrev.assign(mid)
        })
      })
      result.assign(fl(uv()).add(sweep.mul(dPrev.add(dHit).mul(0.5))))
    }).Else(() => {
      result.assign(fl(uv()).add(sweep)) // no crossing (deepest pits) → clamp to full sweep
    })
    return result
  })() as unknown as N
}
