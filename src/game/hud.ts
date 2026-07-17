// HUD — every text readout on screen. Reads state, never touches it: each panel is handed
// getters, so nothing here can accidentally become gameplay.
//
// Two audiences, deliberately separate:
//   • the ULT bar is gameplay UI — it belongs to the player and stays visible in a capture
//   • the debug line and the perf readout are dev chrome — devChrome.ts parents them into
//     the overlay container that fullscreen hides

// --- ultimate bar (gameplay UI) ---------------------------------------------

export interface UltView {
  isActive: boolean
  ready: boolean
  chargeValue: number
  maxCharge: number
  abilityName: string
  activeStatus(): string
}

export function mountUltHud(view: () => UltView, parent: HTMLElement = document.body): () => void {
  const el = document.createElement('div')
  el.id = 'ult'
  el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);font:600 15px/1.4 monospace;letter-spacing:1px;pointer-events:none;text-shadow:0 1px 3px #000;'
  parent.appendChild(el)
  return () => {
    const u = view()
    if (u.isActive) {
      el.textContent = `${u.abilityName}  ${u.activeStatus()}` // e.g. "ZOMBIE EATER  3/10"
      el.style.color = '#ff7a3c' // active — hot
    } else if (u.ready) {
      el.textContent = `(${u.chargeValue}/${u.maxCharge})  ULTIMATE READY`
      el.style.color = '#37e0ff' // ready — bright crystal
    } else {
      el.textContent = `(${u.chargeValue}/${u.maxCharge})`
      el.style.color = '#5f7488' // charging — dim
    }
  }
}

// --- debug line (dev) --------------------------------------------------------

export interface DebugView {
  stickMag: number
  speed: number
  stance: string
  switching: boolean
  aimed: boolean
  waveStatus: string
  alive: number
  corpses: number
  params: { runSpeedMax: number; walkSpeedMax: number; zombieSpeed: number; fireRate: number; damage: number; dismemberChance: number }
}

export function mountDebugHud(el: HTMLElement, view: () => DebugView): () => void {
  return () => {
    const v = view()
    const aimTag = v.switching ? ':switching' : v.stance === 'standing' && v.aimed ? ':FIRING' : ''
    const p = v.params
    el.textContent =
      `stick ${v.stickMag.toFixed(2)}  speed ${v.speed.toFixed(2)} m/s  [${v.stance}${aimTag}]\n` +
      `${v.waveStatus}  zombies ${v.alive}  corpses ${v.corpses}\n` +
      `sys: run ${p.runSpeedMax}  walk ${p.walkSpeedMax}  zspd ${p.zombieSpeed}  rof ${p.fireRate}/s  dmg ${p.damage}  sever ${p.dismemberChance}`
  }
}

// --- perf monitor (dev) ------------------------------------------------------

// REAL frametimes, not the vsync'd display rate:
//   sim = game update CPU cost (input/AI/anim/effects/camera)
//   cpu = render submit cost (three → WebGPU encoding)
//   gpu = measured GPU frame time (timestamp queries, resolved ~5×/s)
//   eng = uncapped engine throughput = 1000 / max(sim+cpu, gpu) — the number that matters
//         for "runs on anything"; display fps just shows vsync
export interface RendererView {
  info: { render: { drawCalls: number; triangles: number } }
  resolveTimestampsAsync?: () => Promise<void>
}

export class PerfHud {
  private el: HTMLElement
  private last = 0
  private gpuReadT = 0
  private simMs = 1
  private cpuMs = 1
  private gpuMs = -1
  private frameMsEma = 16.7
  private lastFrameEnd = -1

  constructor(
    private renderer: RendererView,
    parent: HTMLElement,
  ) {
    this.el = document.createElement('div')
    this.el.id = 'perf'
    this.el.style.cssText = 'position:fixed;right:10px;top:10px;color:#9fb2c5;font:11px/1.5 monospace;pointer-events:none;white-space:pre;text-shadow:0 1px 2px #000;text-align:right;'
    parent.appendChild(this.el)
  }

  private readGpuTime(): void {
    if (typeof this.renderer.resolveTimestampsAsync !== 'function') return
    this.renderer
      .resolveTimestampsAsync()
      .then(() => {
        const ms = (this.renderer.info.render as unknown as { timestamp?: number }).timestamp
        if (typeof ms === 'number' && ms > 0) this.gpuMs = this.gpuMs < 0 ? ms : this.gpuMs * 0.9 + ms * 0.1
      })
      .catch(() => {
        /* timestamp-query feature unavailable — eng falls back to CPU-side cost */
      })
  }

  // t0 = frame start, tRender = sim end / submit start, t1 = frame end
  update(t0: number, tRender: number, t1: number): void {
    this.simMs = this.simMs * 0.9 + (tRender - t0) * 0.1
    this.cpuMs = this.cpuMs * 0.9 + (t1 - tRender) * 0.1
    if (this.lastFrameEnd >= 0) this.frameMsEma = this.frameMsEma * 0.9 + (t1 - this.lastFrameEnd) * 0.1
    this.lastFrameEnd = t1
    if (t1 - this.gpuReadT > 200) {
      this.gpuReadT = t1
      this.readGpuTime()
    }
    if (t1 - this.last < 250) return
    this.last = t1
    const r = this.renderer.info.render
    const tris = r.triangles >= 1000 ? (r.triangles / 1000).toFixed(1) + 'k' : String(r.triangles)
    const cost = Math.max(this.simMs + this.cpuMs, this.gpuMs > 0 ? this.gpuMs : 0)
    const eng = cost > 0 ? Math.round(1000 / cost) : 0
    this.el.textContent =
      `${Math.round(1000 / this.frameMsEma)} fps · ${eng} eng\n` +
      `sim ${this.simMs.toFixed(2)} · cpu ${this.cpuMs.toFixed(2)} · gpu ${this.gpuMs > 0 ? this.gpuMs.toFixed(2) : '—'} ms\n` +
      `${r.drawCalls} draws · ${tris} tris`
  }
}
