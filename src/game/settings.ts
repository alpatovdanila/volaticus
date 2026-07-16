// Settings panels — the editor's Light + Render options, exposed in the game.
// LIGHTING edits the LEVEL's light data live (level.ts owns the values); GRAPHICS
// edits the user registry (userPrefs.ts, persisted per machine). Options that are
// renderer-creation-time (MSAA, anisotropy) save and reload the page.
import { HDRIS, type LightParams, type ToneMap } from '../lib/lighting'
import type { OrbConfig } from './orbs'
import { saveGraphics, type GraphicsPrefs } from './userPrefs'

interface Hooks {
  lights: LightParams // the level's resolved lighting — mutated in place
  graphics: GraphicsPrefs
  orbs?: OrbConfig // level orb config (mutated in place); optional
  onLights: () => void // re-apply the rig after a lighting edit
  onGraphics: () => void // apply live graphics toggles (gtao/tilt/strengths)
  onOrbs?: () => void // re-apply orb intensity after an edit
}

const row = (label: string, control: HTMLElement, value?: HTMLElement): HTMLDivElement => {
  const r = document.createElement('div')
  r.style.cssText = 'display:flex;align-items:center;gap:8px;'
  const l = document.createElement('span')
  l.textContent = label
  l.style.cssText = 'width:80px;'
  r.append(l, control)
  if (value) r.append(value)
  return r
}

const slider = (min: number, max: number, step: number, get: () => number, set: (v: number) => void): HTMLDivElement => {
  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(get())
  input.style.cssText = 'width:110px;'
  const val = document.createElement('span')
  val.textContent = String(get())
  val.style.cssText = 'width:36px;text-align:right;'
  input.oninput = () => {
    set(+input.value)
    val.textContent = input.value
  }
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;'
  wrap.append(input, val)
  return wrap
}

const select = (options: [string, string][], get: () => string, set: (v: string) => void): HTMLSelectElement => {
  const s = document.createElement('select')
  s.style.cssText = 'background:#1a2129;color:#9fb2c5;border:1px solid #2a323c;font:11px monospace;max-width:150px;'
  for (const [v, label] of options) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    s.appendChild(o)
  }
  s.value = get()
  s.onchange = () => set(s.value)
  return s
}

const checkbox = (get: () => boolean, set: (v: boolean) => void): HTMLInputElement => {
  const c = document.createElement('input')
  c.type = 'checkbox'
  c.checked = get()
  c.onchange = () => set(c.checked)
  return c
}

export function mountSettingsPanel(h: Hooks): void {
  const panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;right:10px;top:64px;width:270px;color:#9fb2c5;font:11px/1.7 monospace;user-select:none;display:flex;flex-direction:column;gap:6px;'

  const section = (title: string): [HTMLDetailsElement, HTMLDivElement] => {
    const d = document.createElement('details')
    d.style.cssText = 'background:rgba(10,14,18,0.8);border:1px solid #2a323c;border-radius:6px;padding:6px 10px;'
    const s = document.createElement('summary')
    s.textContent = title
    s.style.cssText = 'cursor:pointer;color:#c9d6e2;'
    const body = document.createElement('div')
    body.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding-top:6px;'
    d.append(s, body)
    panel.appendChild(d)
    return [d, body]
  }

  // --- LIGHTING (level data) ---
  const [, light] = section('lighting (level)')
  const L = h.lights
  light.append(
    row('hdri', select(HDRIS.map((x) => [x.id, x.name]), () => L.hdri, (v) => { L.hdri = v; h.onLights() })),
    row('tonemap', select([['none', 'none'], ['aces', 'ACES'], ['agx', 'AgX']], () => L.tonemap, (v) => { L.tonemap = v as ToneMap; h.onLights() })),
    row('rotation', slider(0, 360, 1, () => L.rotation, (v) => { L.rotation = v; h.onLights() })),
    row('intensity', slider(0, 3, 0.05, () => L.intensity, (v) => { L.intensity = v; h.onLights() })),
    row('shadow', slider(0, 1, 0.05, () => L.shadow, (v) => { L.shadow = v; h.onLights() })),
    row('soft', slider(0, 20, 0.5, () => L.shadowSoft, (v) => { L.shadowSoft = v; h.onLights() })),
    row('ambient', slider(0, 1, 0.02, () => L.ambient, (v) => { L.ambient = v; h.onLights() })),
    row('ao', slider(0, 3, 0.05, () => L.ao, (v) => { L.ao = v; h.onLights() })),
    row('hide bg', checkbox(() => L.hideBg, (v) => { L.hideBg = v; h.onLights() })),
  )
  if (h.orbs) {
    const O = h.orbs
    light.append(row('orb light', slider(0, 20, 0.5, () => O.intensity, (v) => { O.intensity = v; h.onOrbs?.() })))
  }

  // --- GRAPHICS (user registry) ---
  const [, gfx] = section('graphics (user)')
  const G = h.graphics
  const saveReload = (): void => {
    saveGraphics(G)
    location.reload()
  }
  const saveLive = (): void => {
    saveGraphics(G)
    h.onGraphics()
  }
  gfx.append(
    row('aa', select([['off', 'off'], ['ssaa2', 'SSAA 2x'], ['msaa', 'MSAA'], ['msaa_ssaa15', 'MSAA+SSAA 1.5x']], () => G.aa, (v) => { G.aa = v as GraphicsPrefs['aa']; saveReload() })),
    row('gtao', checkbox(() => G.gtao, (v) => { G.gtao = v; saveLive() })),
    row('gtao res', select([['1', '1.0'], ['0.75', '0.75'], ['0.5', '0.5']], () => String(G.gtaoRes), (v) => { G.gtaoRes = +v; saveLive() })),
    row('aniso', select([['1', '1'], ['2', '2'], ['4', '4'], ['8', '8'], ['16', '16']], () => String(G.aniso), (v) => { G.aniso = +v; saveReload() })),
    row('tilt-shift', checkbox(() => G.tilt, (v) => { G.tilt = v; saveLive() })),
    row('tilt str', slider(0, 1, 0.05, () => G.tiltStrength, (v) => { G.tiltStrength = v; saveLive() })),
  )

  document.body.appendChild(panel)
}
