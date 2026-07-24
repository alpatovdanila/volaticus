import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

// a named block of lines, re-read from live state every refresh
type SectionProvider = () => string[]

const REFRESH_HZ = 10
const TOGGLE_KEY = 'F3'

const signed = (n: number) => (n < 0 ? '' : '+') + n.toFixed(2)

/*
 One html panel over the canvas, refreshed a few times a second rather than every frame

 Text sections PULL from live state, so the panel can never drift out of sync with what it is
 reporting on. Toggles are the one thing that pushes: they live in their own element so the
 text rebuild cannot destroy them mid-click.
*/
export class DebugOverlay extends BaseService {
  private root = document.createElement('div')
  private controls = document.createElement('div')
  private text = document.createElement('pre')
  private sections = new Map<string, SectionProvider>()
  private input!: KnownServices['input']
  private playerControl!: KnownServices['playerControl']
  private sinceRefresh = 0
  private visible = true

  create() {
    this.root.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'margin:0',
      'padding:6px 8px',
      'z-index:10',
      'pointer-events:none', // the panel itself never steals a click from the canvas
      'font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:#9fe8b4',
      'background:rgba(6,9,12,.6)',
      'user-select:none',
    ].join(';')

    // ...but the controls inside it must receive clicks, so they opt back in
    this.controls.style.cssText = 'pointer-events:auto;display:flex;gap:10px;margin-bottom:4px'
    this.text.style.cssText = 'margin:0;white-space:pre;font:inherit'

    this.root.append(this.controls, this.text)
    document.body.appendChild(this.root)
    window.addEventListener('keydown', this.onKeyDown)
  }

  init(registry: IServicesRegistry) {
    this.input = registry.get('input')
    this.playerControl = registry.get('playerControl')

    this.addToggle(
      'aim-locked',
      () => this.playerControl.isLocked(),
      (on) => this.playerControl.setLocked(on),
    )
    this.addToggle(
      'sprintable',
      () => this.playerControl.isSprintable(),
      (on) => this.playerControl.setSprintable(on),
    )

    this.addSection('player', () => this.playerLines())
    this.addSection('input', () => this.inputLines())
  }

  /*
   `read` is polled on refresh so the checkbox tracks the underlying state even when something
   else changes it — the control reflects the truth rather than remembering what it last set.
  */
  addToggle(label: string, read: () => boolean, write: (on: boolean) => void) {
    const wrap = document.createElement('label')
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px;cursor:pointer'

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = read()
    box.style.cssText = 'margin:0;width:11px;height:11px;accent-color:#9fe8b4;cursor:pointer'
    box.addEventListener('change', () => write(box.checked))

    wrap.append(box, document.createTextNode(label))
    this.controls.appendChild(wrap)
    this.toggles.push({ box, read })
  }

  private toggles: { box: HTMLInputElement; read: () => boolean }[] = []

  addSection(name: string, provider: SectionProvider) {
    this.sections.set(name, provider)
  }

  removeSection(name: string) {
    this.sections.delete(name)
  }

  update(dt: number) {
    if (!this.visible) return

    this.sinceRefresh += dt
    if (this.sinceRefresh < 1 / REFRESH_HZ) return
    this.sinceRefresh = 0

    for (const { box, read } of this.toggles) {
      const value = read()
      if (box.checked !== value) box.checked = value
    }

    const lines: string[] = []
    for (const provider of this.sections.values()) lines.push(...provider())
    this.text.textContent = lines.join('\n')
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== TOGGLE_KEY) return
    event.preventDefault()
    this.visible = !this.visible
    this.root.style.display = this.visible ? 'block' : 'none'
  }

  private playerLines(): string[] {
    const state = this.playerControl.getDebugState()
    if (!state) return ['player none']
    return [
      `mode   ${state.locked ? 'aim-locked -> arena centre' : 'free'}`,
      `speed  ${state.speed.toFixed(2)} m/s   clip ${state.clip} @${state.rate.toFixed(2)}x`,
    ]
  }

  private inputLines(): string[] {
    // an unfocused page stops receiving gamepad updates, so anything below is a frozen snapshot
    // — worth saying out loud, because a stale readout looks exactly like a live one
    if (!document.hasFocus()) return ['input  page unfocused — gamepad state is stale, input dropped']

    const pad = this.input.getActivePad()
    if (!pad) return ['input  none']

    const buttons = Array.from(pad.buttons)
      .map((b, i) => (b.pressed ? i : null))
      .filter((i) => i !== null)

    // raw axes are always a little off zero at rest; `move` is what survives the deadzone, so
    // that is the line that must read 0.00 with the stick released
    const move = this.input.getMove()
    const throttle = Math.hypot(move.x, move.z)

    return [
      `input  ${pad.id}`,
      `axes   ${Array.from(pad.axes).map(signed).join(' ')}`,
      `move   ${signed(move.x)} ${signed(move.z)}   throttle ${throttle.toFixed(2)}${throttle > 0 ? '  <- should be 0.00 at rest' : ''}`,
      `btns   ${buttons.length ? buttons.join(' ') : '-'}`,
    ]
  }
}

export type IDebugOverlay = InstanceType<typeof DebugOverlay>
