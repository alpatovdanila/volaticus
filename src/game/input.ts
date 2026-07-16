// Player input: gamepad left stick (primary) with a WASD fallback for keyboard dev.
// Output is a single analog MOVE vector in screen space (x = right, y = up) whose
// magnitude carries the walk/run intent: 0..0.5 deflection = walk band, 0.5..1 = run
// band (see locomotion.ts for the speed curve). Radial deadzone, rescaled so the
// usable range starts at 0 — a barely-tilted stick creeps, full tilt sprints.

const DEADZONE = 0.15

export interface MoveInput {
  x: number // -1..1, screen right positive
  y: number // -1..1, screen up positive
  mag: number // 0..1 post-deadzone deflection
}

const keys = new Set<string>()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  window.addEventListener('keydown', (e) => keys.add(e.code))
  window.addEventListener('keyup', (e) => keys.delete(e.code))
  window.addEventListener('blur', () => keys.clear())
}

// Debug/test hook: a synthetic stick (set from the console / verification scripts)
// overrides real devices while non-null. window.__stick(x, y) or __stick(null) to clear.
let synthetic: { x: number; y: number } | null = null
declare global {
  interface Window {
    __stick(x: number | null, y?: number): void
  }
}
if (typeof window !== 'undefined') {
  window.__stick = (x, y = 0) => {
    synthetic = x === null ? null : { x, y }
  }
}

export function pollMove(): MoveInput {
  listen()
  let x = 0
  let y = 0
  if (synthetic) {
    x = synthetic.x
    y = synthetic.y
  } else {
    // strongest gamepad stick wins
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp) continue
      const gx = gp.axes[0] ?? 0
      const gy = -(gp.axes[1] ?? 0) // pad Y is down-positive; we want up-positive
      if (Math.hypot(gx, gy) > Math.hypot(x, y)) {
        x = gx
        y = gy
      }
    }
    // WASD fallback: digital full deflection; hold Shift for the walk band (half stick)
    if (keys.size) {
      let kx = 0
      let ky = 0
      if (keys.has('KeyA') || keys.has('ArrowLeft')) kx -= 1
      if (keys.has('KeyD') || keys.has('ArrowRight')) kx += 1
      if (keys.has('KeyW') || keys.has('ArrowUp')) ky += 1
      if (keys.has('KeyS') || keys.has('ArrowDown')) ky -= 1
      if (kx || ky) {
        const n = Math.hypot(kx, ky)
        const mag = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 0.35 : 1
        x = (kx / n) * mag
        y = (ky / n) * mag
      }
    }
  }
  let mag = Math.hypot(x, y)
  if (mag < DEADZONE) return { x: 0, y: 0, mag: 0 }
  // rescale so the deadzone edge maps to 0 and full tilt stays 1
  const scaled = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE))
  return { x: (x / mag) * scaled, y: (y / mag) * scaled, mag: scaled }
}
