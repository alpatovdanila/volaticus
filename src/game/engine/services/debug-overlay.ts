import { BaseService, IServicesRegistry, KnownServices } from '../services-registry'

// a named block of lines, re-read from live state every refresh
type SectionProvider = () => string[]

const REFRESH_HZ = 10
const TOGGLE_KEY = 'F3'

const signed = (n: number) => (n < 0 ? '' : '+') + n.toFixed(2)

/*
 One html panel over the canvas, refreshed a few times a second rather than every frame —
 the dom is far more expensive to touch than the numbers are to read.

 Services do not push into it: sections pull from live state, so the overlay can never drift
 out of sync with what it is reporting on, and nothing in the engine has to know it exists.
*/
export class DebugOverlay extends BaseService {
  private root = document.createElement('pre')
  private sections = new Map<string, SectionProvider>()
  private input!: KnownServices['input']
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
      'pointer-events:none', // never steals a click from the canvas
      'font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:#9fe8b4',
      'background:rgba(6,9,12,.6)',
      'white-space:pre',
      'user-select:none',
    ].join(';')

    document.body.appendChild(this.root)
    window.addEventListener('keydown', this.onKeyDown)
  }

  init(registry: IServicesRegistry) {
    this.input = registry.get('input')
    this.addSection('input', () => this.inputLines())
  }

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

    const lines: string[] = []
    for (const provider of this.sections.values()) lines.push(...provider())

    this.root.textContent = lines.join('\n')
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== TOGGLE_KEY) return
    event.preventDefault()
    this.visible = !this.visible
    this.root.style.display = this.visible ? 'block' : 'none'
  }

  private inputLines(): string[] {
    const pad = this.input.getActivePad()
    if (!pad) return ['input  none']

    const buttons = Array.from(pad.buttons)
      .map((b, i) => (b.pressed ? i : null))
      .filter((i) => i !== null)

    return [
      `input  ${pad.id}`,
      `axes   ${Array.from(pad.axes).map(signed).join(' ')}`,
      `btns   ${buttons.length ? buttons.join(' ') : '-'}`,
    ]
  }
}

export type IDebugOverlay = InstanceType<typeof DebugOverlay>
