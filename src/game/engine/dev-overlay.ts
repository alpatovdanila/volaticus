import { BaseService, IServicesRegistry, KnownServices } from './services-registry'
import { IsCorpse, IsEnemy, IsPlayer, Projectile, ThreeAnimator } from '@components'

const REDRAW_INTERVAL = 0.2 // seconds — the dom write is the only part of this with real cost
const SMOOTHING = 0.1 // ema weight of the newest sample; raw per-frame times are unreadable

const ROOT_STYLE = `
position: fixed; top: 0; left: 0; z-index: 10000; pointer-events: none;
padding: 6px 8px; background: rgba(0, 0, 0, 0.55); color: #d8d8d8;
font: 10px/1.35 ui-monospace, monospace; font-variant-numeric: tabular-nums;
white-space: pre;
`

/*
Owns THE dev overlay container — one root, so every dev panel renders in the same place and
nothing invents its own floating div. addPanel() hands out children of it.

The perf panel deliberately shows no fps: it is vsync-capped and tells you nothing. Engine fps
is what the cpu and gpu measurements imply if nothing capped them.
*/
export class DevOverlay extends BaseService {
  readonly root = document.createElement('div')

  private registry!: IServicesRegistry
  private renderer!: KnownServices['renderer']
  private world!: KnownServices['world']
  private animator!: KnownServices['threeAnimatorSync']
  private locomotion!: KnownServices['locomotionAnimation']
  private perf = this.addPanel('perf')
  private cpu = 0
  private gpu = 0
  private sinceRedraw = 0

  create() {
    this.root.id = 'dev-overlay'
    this.root.style.cssText = ROOT_STYLE
    document.body.appendChild(this.root)

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Backquote') this.root.style.display = this.root.style.display === 'none' ? '' : 'none'
    })
  }

  init(registry: IServicesRegistry) {
    this.registry = registry
    this.renderer = registry.get('renderer')
    this.world = registry.get('world')
    this.animator = registry.get('threeAnimatorSync')
    this.locomotion = registry.get('locomotionAnimation')
  }

  addPanel(id: string): HTMLElement {
    const panel = document.createElement('div')
    panel.dataset.panel = id
    this.root.appendChild(panel)
    return panel
  }

  update(dt: number) {
    const { info } = this.renderer.webGPURenderer

    this.cpu += (this.registry.cpuTime - this.cpu) * SMOOTHING
    this.gpu += (info.render.timestamp - this.gpu) * SMOOTHING

    this.sinceRedraw += dt
    if (this.sinceRedraw < REDRAW_INTERVAL) return
    this.sinceRedraw = 0

    // gpu is 0 when the adapter has no timestamp-query — say so rather than dividing by it
    const gpuTracked = this.gpu > 0
    const frame = Math.max(this.cpu, this.gpu)

    this.perf.textContent = [
      `cpu   ${ms(this.cpu)}   gpu ${gpuTracked ? ms(this.gpu) : '   n/a'}   engine ${frame > 0 ? Math.round(1000 / frame) : 0} fps`,
      `draws ${info.render.drawCalls}${pad(info.render.drawCalls)}     tris ${count(info.render.triangles)}`,
      `geom  ${info.memory.geometries}${pad(info.memory.geometries)}     tex  ${info.memory.textures}${pad(info.memory.textures)}     vram ${mb(info.memory.total)}`,
      heap(),
      '',
      ...Object.entries(this.registry.timings).map(([name, time]) => ` ${name.padEnd(15)}${ms(time)}`),
      '',
      this.playerClip(),
      this.enemies(),
    ]
      .filter((line) => line !== null)
      .join('\n')
  }

  // current locomotion clip on the player, plus its live playback rate (velocity-tied for
  // locomotion — reading it here catches walk stuck at run's rate or vice versa)
  private playerClip(): string {
    for (const eid of this.world.query([IsPlayer, ThreeAnimator])) {
      const action = this.animator.currentAction(eid)
      if (!action) return 'clip  —'
      return `clip  ${action.getClip().name}   rate ${action.timeScale.toFixed(2)}\nmove  ${this.locomotion.readout(eid)}`
    }
    return 'clip  —'
  }

  // corpses hold an instance slot but cost nothing per frame — worth seeing separately
  private enemies(): string {
    const corpses = this.world.query([IsCorpse]).length
    const enemies = this.world.query([IsEnemy]).length - corpses
    return `enemy ${enemies} live   ${corpses} dead   bullets ${this.world.query([Projectile]).length}`
  }
}

const ms = (value: number) => `${value.toFixed(2).padStart(5)} ms`
const pad = (value: number) => ' '.repeat(Math.max(0, 5 - String(value).length))
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const count = (value: number) => (value < 10000 ? String(value) : `${(value / 1000).toFixed(1)}k`)

// usedJSHeapSize is chrome-only and undeclared in lib.dom — omit the row where it is absent
// rather than reporting a confident 0
const heap = (): string | null => {
  const used = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
  return used === undefined ? null : `heap  ${mb(used)}`
}

export type IDevOverlay = InstanceType<typeof DevOverlay>
