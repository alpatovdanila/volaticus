// Dev tuning panel — live sliders over registry params (bottom-left). Every slider
// writes system.params directly, and consumers read the registry per frame, so drags
// apply instantly. Add fields here whenever something needs hand-tuning; the final
// values then graduate into DEFAULT_PARAMS.
import { system, type GameParams } from './system'

export interface TuningField {
  key: keyof GameParams
  label: string
  min: number
  max: number
  step: number
}

export interface DevButton {
  label: string
  onClick: () => void
  isOn?: () => boolean // toggles render their live state
}

export function mountTuningPanel(fields: TuningField[], buttons: DevButton[] = [], parent: HTMLElement = document.body): void {
  const panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;left:10px;bottom:10px;padding:8px 10px;background:rgba(10,14,18,0.75);' +
    'border:1px solid #2a323c;border-radius:6px;color:#9fb2c5;font:11px/1.6 monospace;user-select:none;'
  if (buttons.length) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;'
    for (const b of buttons) {
      const btn = document.createElement('button')
      btn.style.cssText =
        'padding:3px 10px;background:#1a2129;border:1px solid #2a323c;border-radius:4px;' +
        'color:#9fb2c5;font:11px monospace;cursor:pointer;'
      const paint = (): void => {
        const on = b.isOn?.() ?? false
        btn.textContent = b.label + (b.isOn ? (on ? ' ●' : ' ○') : '')
        btn.style.borderColor = on ? '#e0a33a' : '#2a323c'
        btn.style.color = on ? '#e0a33a' : '#9fb2c5'
      }
      btn.onclick = () => {
        b.onClick()
        paint()
      }
      paint()
      row.appendChild(btn)
    }
    panel.appendChild(row)
  }
  for (const f of fields) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;'
    const label = document.createElement('span')
    label.textContent = f.label
    label.style.cssText = 'width:110px;'
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(f.min)
    input.max = String(f.max)
    input.step = String(f.step)
    // BASE, not params: a slider sets what the value IS. Writing the derived surface
    // would be erased by the next recompute (and would fight any active modifier).
    input.value = String(system.base[f.key])
    input.style.cssText = 'width:140px;'
    const val = document.createElement('span')
    val.textContent = String(system.base[f.key])
    val.style.cssText = 'width:44px;text-align:right;'
    input.oninput = () => {
      system.setBase(f.key, +input.value)
      val.textContent = input.value
    }
    row.append(label, input, val)
    panel.appendChild(row)
  }
  parent.appendChild(panel)
}
