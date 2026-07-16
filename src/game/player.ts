// Player controller — owns the player's STANCE state machine and everything that hangs
// off it. Input is an external system (gamepad today, keyboard, virtual stick on mobile
// tomorrow): it only delivers a MoveInput; all interpretation lives here.
//
//   moving ──(input released)──► settling ──(aimDelay elapses)──► standing
//     ▲                                                              │
//     └────────────────────── any input ◄───────────────────────────┘
//
// Firing is a CAPABILITY of the 'standing' stance — not an input event — so stick
// drift flickering across the deadzone just bounces moving↔settling and never fires,
// and the archero stop-to-shoot beat has one authoritative home.
import * as THREE from 'three'
import type { BuiltEntity } from '../inventory/factory'
import type { MoveInput } from './input'
import { Locomotion, type AimMove } from './locomotion'
import { system } from './system'

export type Stance = 'moving' | 'settling' | 'standing'

export class PlayerController {
  readonly loco: Locomotion
  stance: Stance = 'standing'
  // damage immunity flag — nothing deals damage to the player yet, but dev modes
  // (pacifist) and future powerups set it; the damage pipeline must consult it
  invincible = false
  private settleLeft = 0
  private handBone: THREE.Object3D | null = null
  // forwarded from locomotion: one bolt per firing-animation loop
  onShot: (() => void) | null = null

  constructor(
    readonly built: BuiltEntity,
    private boundsHalf: number,
    private radius: number,
  ) {
    this.loco = new Locomotion(built.group, built.mixer!, built.clips ?? [], {
      idle: 'Idle Rifle',
      walk: 'Rifle Walk',
      run: 'Rifle Run',
      back: 'Run Backward',
      strafeLeft: 'Strafe Run Left',
      strafeRight: 'Strafe Run Right',
      fire: 'Firing Rifle',
    })
    this.loco.onShot = () => this.onShot?.()
    // bolts spawn from the LEFT HAND (the rifle hand) — find its bone once
    built.group.traverse((o) => {
      if ((o as THREE.Bone).isBone && /left.?hand$/i.test(o.name) && !this.handBone) this.handBone = o
    })
  }

  get position(): THREE.Vector3 {
    return this.built.group.position
  }

  // world-space bolt origin: the live hand bone (falls back to a chest-height offset
  // if the rig has no left hand — never the bbox edge)
  muzzle(): THREE.Vector3 {
    if (this.handBone) return this.handBone.getWorldPosition(new THREE.Vector3())
    return this.position
      .clone()
      .setY(1.1)
      .add(new THREE.Vector3(0, 0, 0.35).applyQuaternion(this.built.group.quaternion))
  }

  // one tick: consume input, advance the stance machine, integrate movement, aim/fire.
  // `aim` = the target point the game proposes (nearest enemy). AIMED ≠ SHOOTING:
  // with a target in range the player FACES it in every stance (backpedaling away
  // plays the backward run); firing remains a capability of 'standing' only.
  update(dt: number, move: MoveInput, aim: THREE.Vector3 | null): number {
    // stance transitions
    if (move.mag > 0) {
      this.stance = 'moving'
    } else if (this.stance === 'moving') {
      this.stance = 'settling'
      this.settleLeft = system.params.aimDelay // registry: tune the stop-to-shoot beat live
    } else if (this.stance === 'settling') {
      this.settleLeft -= dt
      if (this.settleLeft <= 0) this.stance = 'standing'
    }

    const aimed = aim !== null
    if (aim) this.loco.faceToward(aim, dt) // face the target in EVERY stance while aimed

    // locomotion + integration
    const dir = { x: move.x, z: -move.y } // screen up = -Z, screen right = +X
    const n = Math.hypot(dir.x, dir.z)
    if (n > 0) {
      dir.x /= n
      dir.z /= n
    }
    // aim-locked → classify movement relative to FACING into forward / back / strafe L-R,
    // whichever axis dominates. The body faces the target (faceToward above); the feet play
    // the matching directional clip. Not aimed → aimMove null (normal face-the-move gait).
    let aimMove: AimMove | null = null
    if (aimed && move.mag > 0) {
      const q = this.built.group.quaternion
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q) // model forward = +Z
      const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(q) // …so the character's right is local −X
      const f = dir.x * fwd.x + dir.z * fwd.z // forward component
      const r = dir.x * right.x + dir.z * right.z // rightward component
      aimMove = Math.abs(r) > Math.abs(f) ? (r > 0 ? 'right' : 'left') : f < 0 ? 'back' : 'forward'
    }
    const speed = this.loco.update(dt, dir, move.mag, { faceMovement: !aimed, aimMove })
    if (speed > 0) {
      const p = this.built.group.position
      p.x = THREE.MathUtils.clamp(p.x + dir.x * speed * dt, -this.boundsHalf + this.radius, this.boundsHalf - this.radius)
      p.z = THREE.MathUtils.clamp(p.z + dir.z * speed * dt, -this.boundsHalf + this.radius, this.boundsHalf - this.radius)
    }

    // firing: a standing-only capability (aimed while moving = tracked, not shot)
    this.loco.setFiring(this.stance === 'standing' && aimed)
    return speed
  }
}
