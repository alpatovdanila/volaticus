import { BaseService } from '../services-registry'

const DEADZONE = 0.15

// a pad is "live" if the player is visibly touching it right now
const isProducingInput = (pad: Gamepad) => {
  for (let i = 0; i < pad.axes.length; i++) if (Math.abs(pad.axes[i]) > DEADZONE) return true
  for (let i = 0; i < pad.buttons.length; i++) if (pad.buttons[i].pressed) return true
  return false
}

/*
 Left stick, polled once per frame. The magnitude survives (it is not normalised to 1) so
 callers can tell a gentle push from a full one — that is what selects walk vs run.
*/
export class Input extends BaseService {
  private moveX = 0
  private moveZ = 0

  // the pad the last poll actually chose. The debug overlay reads this rather than re-polling,
  // so the panel can never disagree with the device that is driving the game.
  private pads: Gamepad[] = []
  private pad: Gamepad | null = null
  private activeIndex: number | null = null

  update() {
    const pad = this.pollPad()
    if (!pad) return this.clear()

    const x = pad.axes[0] ?? 0
    const y = pad.axes[1] ?? 0
    const magnitude = Math.hypot(x, y)
    if (magnitude < DEADZONE) return this.clear()

    // rescale past the deadzone so the first responsive input is 0, not a jump to 0.15
    const scaled = (magnitude - DEADZONE) / (1 - DEADZONE)
    this.moveX = (x / magnitude) * scaled
    this.moveZ = (y / magnitude) * scaled // stick up is -1, which is forward (-Z) in three
  }

  /*
   Picking the pad is not "take the first one": the browser enumerates plenty of things as
   gamepads that nobody is holding — keyboards, dongles, wheels — and those sit at low slots
   reporting axes that never leave zero. So, in order of confidence:

     1. a pad producing input right now — unambiguous evidence of the one in the player's hands
     2. the pad already chosen, while it stays connected, so the choice does not flicker
     3. a standard-mapping pad — the impostors almost always report a non-standard mapping
     4. anything left

   getGamepads() also hands back a snapshot that must be re-read every frame, and in some
   engines it is a sparse array-like (GamepadList) rather than a real Array — hence indexing
   rather than Array methods, which would throw there.
  */
  private pollPad(): Gamepad | null {
    const polled = navigator.getGamepads ? navigator.getGamepads() : []

    this.pads.length = 0
    let live: Gamepad | null = null
    let sticky: Gamepad | null = null
    let standard: Gamepad | null = null

    for (let i = 0; i < polled.length; i++) {
      const pad = polled[i]
      if (!pad || !pad.connected) continue

      this.pads.push(pad)
      if (!live && isProducingInput(pad)) live = pad
      if (pad.index === this.activeIndex) sticky = pad
      if (!standard && pad.mapping === 'standard') standard = pad
    }

    const chosen = live ?? sticky ?? standard ?? this.pads[0] ?? null
    this.activeIndex = chosen ? chosen.index : null
    this.pad = chosen
    return chosen
  }

  private clear() {
    this.moveX = 0
    this.moveZ = 0
  }

  getMove() {
    return { x: this.moveX, z: this.moveZ }
  }

  getActivePad(): Gamepad | null {
    return this.pad
  }
}

export type IInput = InstanceType<typeof Input>
