import { BaseService, IServicesRegistry, KnownServices } from './services-registry'
import { Texture } from 'three'

import { IsCorpse, IsEnemy, IsPlayer, Projectile, ThreeAnimator, Weapon } from '@components'
import { WeaponState } from '@lib/weapon'

const REDRAW_INTERVAL = 0.2 // seconds — the dom write is the only part of this with real cost
const SMOOTHING = 0.1 // ema weight of the newest sample; raw per-frame times are unreadable

// [min, max, step] per weapon field. Every field is a number, so the whole panel builds from this
// rather than from a hand-written row each — a new stat gets a slider by appearing here
const WEAPON_RANGE: Record<keyof WeaponState, [number, number, number]> = {
  shotsPerMinute: [30, 900, 5],
  shots: [1, 9, 1],
  fan: [0, 120, 1],
  fanOffset: [0, 1, 0.05],
  bulletsPerShot: [1, 12, 1],
  spread: [0, 30, 0.5],
  damage: [1, 20, 1],
  speed: [4, 60, 0.5],
  range: [4, 40, 1],
  bounces: [0, 12, 1],
  bounceRange: [1, 20, 0.5],
  dismemberChance: [0, 1, 0.05],
}

const WEAPON_STYLE = `
margin-top: 8px; display: grid; gap: 2px 6px; align-items: center;
grid-template-columns: 96px 108px 40px; pointer-events: auto;
`

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
  private weapon = this.addPanel('weapon')
  private cpu = 0
  private gpu = 0
  private sinceRedraw = 0
  private weaponBound = false

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

    this.bindWeapon()

    // gpu is 0 when the adapter has no timestamp-query — say so rather than dividing by it
    const gpuTracked = this.gpu > 0
    const frame = Math.max(this.cpu, this.gpu)

    this.perf.textContent = [
      `cpu   ${ms(this.cpu)}   gpu ${gpuTracked ? ms(this.gpu) : '   n/a'}   engine ${frame > 0 ? Math.round(1000 / frame) : 0} fps`,
      `draws ${info.render.drawCalls}${pad(info.render.drawCalls)}     tris ${count(info.render.triangles)}`,
      `geom  ${info.memory.geometries}${pad(info.memory.geometries)}     tex  ${info.memory.textures}${pad(info.memory.textures)}     vram ${mb(info.memory.total)}`,
      // which bucket vram is actually in. A total that climbs with no scene change is a leak, and
      // this says where — textures, geometry buffers, per-material uniforms or render targets
      // rb is the one to watch: trackTimestamp allocates a readback buffer per resolve, and a
      // device without timestamp-query support may never hand them back
      `      tex ${mb(info.memory.texturesSize)}  buf ${mb(buffers(info.memory))}  ubo ${mb(info.memory.uniformBuffersSize)}  rt ${info.memory.renderTargets}  rb ${info.memory.readbackBuffers}`,
      this.textureKinds(),
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

  /*
  What the live textures actually ARE, most numerous first.

  A count alone says something leaks; this says what. three's Info keeps a map keyed by the
  objects it is accounting for, so the textures still alive can be grouped by size and type — and
  a thousand copies of one size names the culprit immediately.
  */
  private textureKinds(): string {
    const tracked = (this.renderer.webGPURenderer.info as { memoryMap?: Map<object, unknown> }).memoryMap
    if (!tracked) return 'tex   —'

    const counts = new Map<string, number>()
    for (const key of tracked.keys()) {
      const texture = key as Texture
      if (!texture.isTexture) continue

      const image = texture.image as { width?: number; height?: number } | undefined
      const label = `${texture.name || texture.constructor.name}${image?.width ?? '?'}x${image?.height ?? '?'}`
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }

    const top = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, count]) => `${label} x${count}`)
    return `      ${top.join('   ') || 'none'}`
  }

  /*
  Sliders straight onto the player's Weapon component — the same record a level-up trait will
  edit, so tuning here is exactly what an upgrade does and there is nothing to apply or reload.

  Built once, the first redraw after a player carries a weapon.
  */
  private bindWeapon() {
    if (this.weaponBound) return

    const [eid] = this.world.query([IsPlayer, Weapon])
    if (eid === undefined) return
    this.weaponBound = true

    this.weapon.style.cssText = WEAPON_STYLE

    for (const field of Object.keys(WEAPON_RANGE) as (keyof WeaponState)[]) {
      const [min, max, step] = WEAPON_RANGE[field]

      const name = document.createElement('span')
      name.textContent = field

      const slider = document.createElement('input')
      slider.type = 'range'
      slider.min = String(min)
      slider.max = String(max)
      slider.step = String(step)
      slider.value = String(Weapon[eid][field])
      slider.style.cssText = 'width: 108px; height: 10px; margin: 0;'

      const readout = document.createElement('span')
      readout.textContent = show(Weapon[eid][field], step)

      slider.addEventListener('input', () => {
        const value = Number(slider.value)
        Weapon[eid][field] = value
        readout.textContent = show(value, step)
      })

      this.weapon.append(name, slider, readout)
    }
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

// as many decimals as the step implies, so an integer stat never reads "4.00"
const show = (value: number, step: number) => (step < 1 ? value.toFixed(2) : String(value))

const ms = (value: number) => `${value.toFixed(2).padStart(5)} ms`
const pad = (value: number) => ' '.repeat(Math.max(0, 5 - String(value).length))
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

// every kind of vertex data in one number; the split between them never matters, the total does
const buffers = (memory: { attributesSize: number; indexAttributesSize: number; storageAttributesSize: number }) =>
  memory.attributesSize + memory.indexAttributesSize + memory.storageAttributesSize

const count = (value: number) => (value < 10000 ? String(value) : `${(value / 1000).toFixed(1)}k`)

// usedJSHeapSize is chrome-only and undeclared in lib.dom — omit the row where it is absent
// rather than reporting a confident 0
const heap = (): string | null => {
  const used = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
  return used === undefined ? null : `heap  ${mb(used)}`
}

export type IDevOverlay = InstanceType<typeof DevOverlay>
