import { BaseService } from './services-registry'

const DEADZONE = 0.15

/*
Left stick, polled once per frame.

Deflection MAGNITUDE survives — it is not normalised to 1 — because how far the stick is pushed
is what downstream turns into speed, and speed is what picks walk from run.
*/
export class Input extends BaseService {
  private moveX = 0
  private moveZ = 0
  private activeIndex: number | null = null
  // one-frame edge detection: previous holds last frame's button snapshot, current holds this
  // frame's; wasPressed(i) is `current && !previous`. Arrays because a Gamepad's button set is
  // ordinal
  private previousButtons: boolean[] = []
  private currentButtons: boolean[] = []
  // mouse in normalised device coords ([-1, +1] on both axes, +y up). Consumers project through
  // the camera; storing NDC keeps this service ignorant of both camera and canvas
  private mouseNdcX = 0
  private mouseNdcY = 0

  create() {
    window.addEventListener('mousemove', (e) => {
      this.mouseNdcX = (e.clientX / window.innerWidth) * 2 - 1
      this.mouseNdcY = -((e.clientY / window.innerHeight) * 2 - 1) // CSS y grows down, NDC grows up
    })
  }

  update() {
    // shift current → previous BEFORE polling: this frame's read becomes the next frame's "was"
    this.previousButtons = this.currentButtons
    this.currentButtons = []

    /*
    An unfocused page does not get fresh gamepad state: getGamepads() keeps handing back the LAST
    snapshot indefinitely rather than reporting neutral. Alt-tab mid-movement and the engine reads
    a stick frozen at whatever deflection it had, walking the character off forever — and no
    deadzone catches it, because those frozen values are legitimate full-scale readings.

    Dropping input while unfocused is also just what a game should do with a held stick.
    */
    if (!document.hasFocus()) return this.clear()

    const pad = this.pollPad()
    if (!pad) return this.clear()

    for (let i = 0; i < pad.buttons.length; i++) this.currentButtons[i] = pad.buttons[i].pressed

    const x = pad.axes[0] ?? 0
    const y = pad.axes[1] ?? 0

    // radial, not per-axis: testing each axis separately clips the diagonals into a square notch
    const magnitude = Math.hypot(x, y)
    if (magnitude < DEADZONE) return this.clear()

    /*
    Rescale past the deadzone so the first responsive input is 0 rather than jumping to 0.15 of
    full speed, and CLAMP: a square-gated stick reads up to 1.41 on the diagonal, which would be a
    41% speed bonus for moving diagonally.

    The clamp is on the throttle, NOT on the magnitude used to normalise — dividing by a clamped
    magnitude would leave the direction vector itself over-long and put the bonus straight back.
    */
    const throttle = Math.min(1, (magnitude - DEADZONE) / (1 - DEADZONE))
    this.moveX = (x / magnitude) * throttle
    this.moveZ = (y / magnitude) * throttle // stick up reads -1, and -Z is away from the camera
  }

  getMove() {
    return { x: this.moveX, z: this.moveZ }
  }

  // standard-mapping index: A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, ...
  wasPressed(button: number): boolean {
    return !!this.currentButtons[button] && !this.previousButtons[button]
  }

  getMouseNdc() {
    return { x: this.mouseNdcX, y: this.mouseNdcY }
  }

  /*
  Not "take slot 0": browsers enumerate keyboards, dongles and wheels as gamepads, and those sit
  in low slots reporting axes that never move. In order of confidence:

    1. a pad producing input right now — unambiguous evidence of the one being held
    2. the pad already chosen, while it stays connected, so the choice cannot flicker
    3. a standard-mapping pad — the impostors rarely claim one
    4. whatever is left

  Indexed rather than iterated with array methods: getGamepads() may return a sparse GamepadList.
  */
  private pollPad(): Gamepad | null {
    const polled = navigator.getGamepads ? navigator.getGamepads() : []

    let live: Gamepad | null = null
    let sticky: Gamepad | null = null
    let standard: Gamepad | null = null
    let any: Gamepad | null = null

    for (let i = 0; i < polled.length; i++) {
      const pad = polled[i]
      if (!pad || !pad.connected) continue

      if (!any) any = pad
      if (!live && isInUse(pad)) live = pad
      if (pad.index === this.activeIndex) sticky = pad
      if (!standard && pad.mapping === 'standard') standard = pad
    }

    const chosen = live ?? sticky ?? standard ?? any
    this.activeIndex = chosen ? chosen.index : null
    return chosen
  }

  private clear() {
    this.moveX = 0
    this.moveZ = 0
  }
}

// a pad is being held if anything on it has visibly moved
const isInUse = (pad: Gamepad): boolean => {
  for (let i = 0; i < pad.axes.length; i++) if (Math.abs(pad.axes[i]) > DEADZONE) return true
  for (let i = 0; i < pad.buttons.length; i++) if (pad.buttons[i].pressed) return true
  return false
}

export type IInput = InstanceType<typeof Input>
