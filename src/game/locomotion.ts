// Analog locomotion for the player character — drives the entity's OWN AnimationMixer
// directly (no EntityPreview: a state machine crossfades whole states; locomotion needs
// continuous weight blending AND per-frame playback-rate control inside each phase).
//
// The stick's deflection magnitude maps to ground speed on a single continuous curve:
//   0……0.5  → walk band, 0 → WALK_MAX m/s
//   0.5……1  → run band, WALK_MAX → RUN_MAX m/s (max speed at full deflection)
// The active clip's timeScale follows speed/nominal-clip-speed, so feet track the ground
// at every deflection instead of sliding. Phase changes (idle↔walk↔run) are weight
// crossfades with hysteresis at the walk/run boundary so a wavering stick can't flap.
import * as THREE from 'three'
import { system } from './system'
import { sim } from './clock'

const BLEND_RATE = 9 // 1/s — exponential approach for phase weights
const TURN_RATE = 14 // 1/s — heading slerp
const RUN_ENTER = 0.55 // hysteresis: walk→run above this deflection…
const RUN_EXIT = 0.45 // …run→walk below this
const AIM_LOCK = 0.11 // rad (~6°) — aligned enough onto the target to fire
const AIM_UNLOCK = 0.3 // rad (~17°) — a miss this big is a real target switch → hold fire

export function speedFor(mag: number): number {
  // live registry reads: speed tuning/upgrades reshape the curve instantly
  const { walkSpeedMax, runSpeedMax } = system.params
  if (mag <= 0) return 0
  if (mag <= 0.5) return (mag / 0.5) * walkSpeedMax
  return walkSpeedMax + ((mag - 0.5) / 0.5) * (runSpeedMax - walkSpeedMax)
}

type Phase = 'idle' | 'walk' | 'run'
// movement direction relative to FACING while aim-locked (body faces the target, feet
// travel some other way) — each picks a dedicated clip in place of the forward gait
export type AimMove = 'forward' | 'back' | 'left' | 'right'

export class Locomotion {
  private idle: THREE.AnimationAction
  private walk: THREE.AnimationAction
  private run: THREE.AnimationAction
  private back: THREE.AnimationAction | null // backpedal clip — moving away while aimed
  private strafeL: THREE.AnimationAction | null // aim-locked lateral move to the left
  private strafeR: THREE.AnimationAction | null // …and to the right
  private fire: THREE.AnimationAction | null
  private fireClipDur = 0
  private walkDur = 1
  private runDur = 1
  private backDur = 1
  private strafeLDur = 1
  private strafeRDur = 1
  private phase: Phase = 'idle'
  private heading = 0 // current facing yaw (radians; model forward = +Z)
  private fireLooping = false
  private lastShot = -Infinity // sim seconds of the last bolt — rate-limits re-engage
  // one shot per animation loop — the game layer spawns the bolt here, so projectiles
  // stay in lockstep with the firing animation at ANY fire rate (timeScale-synced below)
  onShot: (() => void) | null = null
  // one call per FOOTFALL, paced off the gait clip that's actually playing (see
  // advanceSteps): the feet own the cadence, so nothing downstream has to re-derive it
  // from speed and guess which band/clip we're in.
  onStep: (() => void) | null = null
  private stepPhase = 0.6 // primed: the first step lands quickly after moving again

  constructor(
    private group: THREE.Object3D,
    private mixer: THREE.AnimationMixer,
    clips: THREE.AnimationClip[],
    names: { idle: string; walk: string; run: string; back?: string; strafeLeft?: string; strafeRight?: string; fire?: string },
  ) {
    const byName = new Map(clips.map((c) => [c.name, c]))
    const action = (n: string): THREE.AnimationAction => {
      const clip = byName.get(n)
      if (!clip) throw new Error(`locomotion: missing clip "${n}"`)
      const a = mixer.clipAction(clip)
      a.play()
      a.setEffectiveWeight(0)
      return a
    }
    this.idle = action(names.idle)
    this.walk = action(names.walk)
    this.run = action(names.run)
    this.idle.setEffectiveWeight(1)
    this.walkDur = byName.get(names.walk)!.duration
    this.runDur = byName.get(names.run)!.duration
    if (names.back && byName.has(names.back)) {
      this.back = action(names.back)
      this.backDur = byName.get(names.back)!.duration
    } else this.back = null
    if (names.strafeLeft && byName.has(names.strafeLeft)) {
      this.strafeL = action(names.strafeLeft)
      this.strafeLDur = byName.get(names.strafeLeft)!.duration
    } else this.strafeL = null
    if (names.strafeRight && byName.has(names.strafeRight)) {
      this.strafeR = action(names.strafeRight)
      this.strafeRDur = byName.get(names.strafeRight)!.duration
    } else this.strafeR = null
    if (names.fire && byName.has(names.fire)) {
      // CONTINUOUS firing: the clip is one shot, so it LOOPS while engaged — one loop
      // per shot, crossfaded like any locomotion phase (no LoopOnce gaps → no T-pose
      // flash between shots). timeScale in update() paces the loop to the fire rate.
      const clip = byName.get(names.fire)!
      this.fireClipDur = clip.duration
      this.fire = mixer.clipAction(clip)
      this.fire.setEffectiveWeight(0)
      mixer.addEventListener('loop', (e) => {
        if ((e as unknown as { action: THREE.AnimationAction }).action === this.fire && this.fireLooping) this.emitShot()
      })
    } else this.fire = null
  }

  // engage/disengage the firing loop (only meaningful while stationary — the caller gates that)
  setFiring(on: boolean): void {
    if (!this.fire || on === this.fireLooping) return
    this.fireLooping = on
    if (on) {
      this.fire.reset().play()
      this.emitShot() // first bolt immediately (rate-limited: toggling can't exceed fireRate)
    }
  }

  // rate gate shared by the loop-paced shots and the engage shot: stick drift flickering
  // across the deadzone (or tap-stop-tap play) re-engages constantly — without this gate
  // every re-engage would fire instantly, turning drift into a machine gun.
  private emitShot(): void {
    // SIM time: a pause (or a hitch) must not let the gate elapse behind the player's back
    const now = sim.now
    if (now - this.lastShot < 0.95 / system.params.fireRate) return
    this.lastShot = now
    this.onShot?.()
  }

  // face a world point (used while locked on a target). NOT the exponential movement
  // turn: aim snaps on a slightly-underdamped SPRING — it accelerates into the turn,
  // carries momentum, and settles with a whisper of overshoot, like a practiced shooter
  // throwing the gun onto the next target. Stiffness is a live registry read.
  private aimVel = 0 // yaw angular velocity (rad/s) — the spring's state
  private aimLocked = true // latched aim-settled flag (hysteresis band AIM_LOCK..AIM_UNLOCK)
  faceToward(target: THREE.Vector3, dt: number): void {
    const dx = target.x - this.group.position.x
    const dz = target.z - this.group.position.z
    if (dx * dx + dz * dz < 1e-6) return
    const yaw = Math.atan2(dx, dz)
    let err = yaw - this.heading
    while (err > Math.PI) err -= Math.PI * 2
    while (err < -Math.PI) err += Math.PI * 2
    // aim lock with hysteresis: a big miss (a NEW target) unlocks → 'switching', and it
    // re-locks only once tightly aligned — the band keeps the spring's small end-of-sweep
    // overshoot from flickering the lock (and firing) back off.
    const a = Math.abs(err)
    if (a > AIM_UNLOCK) this.aimLocked = false
    else if (a < AIM_LOCK) this.aimLocked = true
    const stiff = system.params.aimTurnStiffness
    const damping = 2 * 0.68 * Math.sqrt(stiff) // ζ = 0.68: underdamped → pronounced accel + a weighty overshoot
    this.aimVel += (stiff * err - damping * this.aimVel) * dt
    this.heading += this.aimVel * dt
    this.group.rotation.y = this.heading
  }

  // true once the gun has settled onto the target; false while still sweeping to it. The
  // controller holds fire until this is true (the 'switching targets' state).
  aimSettled(): boolean {
    return this.aimLocked
  }

  // dir = desired WORLD-space move direction (unit XZ), mag = stick deflection 0..1.
  // opts.faceMovement: turn toward the move direction (false while aimed at a target —
  // the controller owns facing then). opts.backpedal: play the backward clip (moving
  // away from an acquired target while still facing it). Returns the ground speed.
  update(
    dt: number,
    dir: { x: number; z: number },
    mag: number,
    opts: { faceMovement?: boolean; aimMove?: AimMove | null } = {},
  ): number {
    const speed = speedFor(mag)
    // phase select with run-boundary hysteresis
    if (mag <= 0) this.phase = 'idle'
    else if (this.phase === 'run') this.phase = mag < RUN_EXIT ? 'walk' : 'run'
    else this.phase = mag > RUN_ENTER ? 'run' : 'walk'

    // aim-locked → movement is DIRECTIONAL: the body faces the target, so the relative
    // heading selects a dedicated clip (backpedal / strafe L-R) in place of the forward
    // gait. Not aimed (aimMove undefined) → treated as 'forward' (normal walk/run).
    const moving = this.phase !== 'idle'
    const aimMove = opts.aimMove ?? 'forward'
    const useBack = moving && aimMove === 'back' && this.back !== null
    const useSL = moving && aimMove === 'left' && this.strafeL !== null
    const useSR = moving && aimMove === 'right' && this.strafeR !== null
    const useFwd = moving && !useBack && !useSL && !useSR // forward gait (walk/run band)

    // analog rate inside every locomotion clip — LOOPS-PER-METER coupling (registry-
    // tunable): timeScale = speed × lpm × clipDuration → feet track the ground at any speed
    const runLpm = system.params.playerRunLpm
    this.walk.timeScale = THREE.MathUtils.clamp(speed * system.params.playerWalkLpm * this.walkDur, 0.2, 3)
    this.run.timeScale = THREE.MathUtils.clamp(speed * runLpm * this.runDur, 0.2, 3)
    if (this.back) this.back.timeScale = THREE.MathUtils.clamp(speed * runLpm * this.backDur, 0.2, 3)
    if (this.strafeL) this.strafeL.timeScale = THREE.MathUtils.clamp(speed * runLpm * this.strafeLDur, 0.2, 3)
    if (this.strafeR) this.strafeR.timeScale = THREE.MathUtils.clamp(speed * runLpm * this.strafeRDur, 0.2, 3)
    // one firing loop = one shot interval — live registry read, upgrades re-pace mid-fight
    if (this.fire) this.fire.timeScale = this.fireClipDur * system.params.fireRate

    // weight crossfade toward the target set (exponential — frame-rate independent). Exactly
    // one movement clip is active; fire replaces idle while engaged. Weights always blend
    // continuously, never a zero-weight (T-pose) gap.
    const k = 1 - Math.exp(-BLEND_RATE * dt)
    const fireW = this.fireLooping && this.phase === 'idle' ? 1 : 0
    const blend = (a: THREE.AnimationAction | null, t: number): void => {
      if (a) a.setEffectiveWeight(a.getEffectiveWeight() + (t - a.getEffectiveWeight()) * k)
    }
    blend(this.idle, this.phase === 'idle' && !fireW ? 1 : 0)
    blend(this.walk, useFwd && this.phase === 'walk' ? 1 : 0)
    blend(this.run, useFwd && this.phase === 'run' ? 1 : 0)
    blend(this.back, useBack ? 1 : 0)
    blend(this.strafeL, useSL ? 1 : 0)
    blend(this.strafeR, useSR ? 1 : 0)
    blend(this.fire, fireW)

    // face the move direction while the stick is live (unless the controller aims us)
    if (mag > 0 && (opts.faceMovement ?? true)) this.turnTo(Math.atan2(dir.x, dir.z), dt)

    this.advanceSteps(dt)
    this.mixer.update(dt)
    return speed
  }

  // footstep cadence, read off the gait the FEET are actually playing: the heaviest-
  // weighted movement clip, at the timeScale it's really running (clamp included). Two
  // steps per gait loop.
  //
  // This must not be re-derived from speed anywhere else. It was, and the two disagreed:
  // a speed-based guess picks its own walk/run band (missing this one's hysteresis, so
  // steps and feet diverge in the 0.45–0.55 stick band) and can't know that a strafe or
  // backpedal is playing a different clip at a different rate. Feet are ground truth.
  private advanceSteps(dt: number): void {
    let best: THREE.AnimationAction | null = null
    let bestW = 0.5 // under half weight, no clip is really "the" gait
    for (const a of [this.walk, this.run, this.back, this.strafeL, this.strafeR]) {
      if (!a) continue
      const w = a.getEffectiveWeight()
      if (w > bestW) {
        bestW = w
        best = a
      }
    }
    if (!best || this.phase === 'idle') {
      this.stepPhase = 0.6 // re-prime while standing
      return
    }
    const dur = best.getClip().duration
    if (dur <= 0) return
    this.stepPhase += 2 * (Math.abs(best.timeScale) / dur) * dt // timeScale/dur = loops per second
    while (this.stepPhase >= 1) {
      this.stepPhase -= 1
      this.onStep?.()
    }
  }

  private turnTo(yaw: number, dt: number): void {
    let d = yaw - this.heading
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    this.heading += d * (1 - Math.exp(-TURN_RATE * dt))
    this.group.rotation.y = this.heading
    this.aimVel = 0 // movement turning owns the heading — stale spring momentum would kick on re-aim
  }
}
