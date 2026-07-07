// Keyframe animation over named rig nodes. Track values are OFFSETS from the
// authored base pose (rot in degrees, pos in meters, scale multiplicative) so
// clips compose over any base transform.
import * as THREE from 'three'
import { EASE, type EaseName } from '../lib/easing'
import type { BuiltEntity } from './factory'
import type { ClipDef, TrackDef } from './schema'

type Offsets = { pos: [number, number, number]; rot: [number, number, number]; scale: number }
type Pose = Map<string, Offsets>

function emptyOffsets(): Offsets {
  return { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1 }
}

function sampleTrack(track: TrackDef, t: number): number {
  const keys = track.keys
  if (t <= keys[0][0]) return keys[0][1]
  const last = keys[keys.length - 1]
  if (t >= last[0]) return last[1]
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i]
    const [t1, v1] = keys[i + 1]
    if (t >= t0 && t <= t1) {
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1
      return v0 + (v1 - v0) * EASE[(track.ease ?? 'linear') as EaseName](u)
    }
  }
  return last[1]
}

function samplePose(clip: ClipDef, t: number): Pose {
  const pose: Pose = new Map()
  for (const track of clip.tracks) {
    let o = pose.get(track.node)
    if (!o) pose.set(track.node, (o = emptyOffsets()))
    const v = sampleTrack(track, t)
    const [group, axis] = track.prop.split('.')
    if (group === 'scale') o.scale = v
    else if (group === 'pos') o.pos['xyz'.indexOf(axis) as 0 | 1 | 2] = v
    else o.rot['xyz'.indexOf(axis) as 0 | 1 | 2] = v
  }
  return pose
}

function lerpPose(a: Pose, b: Pose, u: number): Pose {
  const out: Pose = new Map()
  const names = new Set([...a.keys(), ...b.keys()])
  for (const n of names) {
    const oa = a.get(n) ?? emptyOffsets()
    const ob = b.get(n) ?? emptyOffsets()
    out.set(n, {
      pos: [0, 1, 2].map((i) => oa.pos[i] + (ob.pos[i] - oa.pos[i]) * u) as [number, number, number],
      rot: [0, 1, 2].map((i) => oa.rot[i] + (ob.rot[i] - oa.rot[i]) * u) as [number, number, number],
      scale: oa.scale + (ob.scale - oa.scale) * u,
    })
  }
  return out
}

const BLEND_TIME = 0.15

// Deterministic loop phase (0..1) from a stable key — FNV-1a over the string.
// Feed it a placed instance id or a scatter point's stored coords: the same
// key replays the same phase forever, so identical props sway out of unison
// without any build/render-time randomness. Reused wherever anims need a
// per-instance offset (game world, future editor anim playback).
export function animPhaseFor(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

export interface AnimStep {
  t0: number
  t1: number
  wrapped: boolean
  duration: number
}

export class AnimPlayer {
  private current: { name: string; clip: ClipDef; t: number } | null = null
  private blendFrom: Pose | null = null
  private blendLeft = 0

  constructor(
    private built: BuiltEntity,
    private clips: Record<string, ClipDef>,
  ) {}

  play(name: string | null, blend = BLEND_TIME): void {
    this.blendFrom = this.currentPose()
    // rot offsets are degrees over the base pose, so 360 ≡ 0 visually — wrap
    // the blend source into (-180, 180] so leaving a full-turn clip (double-
    // jump flip at 360°, spun propellers) blends the SHORT way, never a fast
    // backward unwind through the whole accumulated angle
    for (const o of this.blendFrom.values())
      for (let i = 0; i < 3; i++) {
        let r = o.rot[i] % 360
        if (r > 180) r -= 360
        else if (r <= -180) r += 360
        o.rot[i] = r
      }
    this.blendLeft = blend
    this.current = name && this.clips[name] ? { name, clip: this.clips[name], t: 0 } : null
  }

  get time(): number {
    return this.current?.t ?? 0
  }

  // Shift the CURRENT clip to a mid-cycle phase (u = 0..1 of the duration).
  // LOOPING clips only — one-shots (transitions, overlays) must start at t=0.
  setPhase(u: number): void {
    if (this.current?.clip.loop) this.current.t = (((u % 1) + 1) % 1) * this.current.clip.duration
  }

  private currentPose(): Pose {
    if (!this.current) return new Map()
    const { clip, t } = this.current
    const ct = clip.loop ? t % clip.duration : Math.min(t, clip.duration)
    return samplePose(clip, ct)
  }

  update(dt: number): AnimStep {
    let step: AnimStep = { t0: 0, t1: 0, wrapped: false, duration: 1 }
    if (this.current) {
      const { clip } = this.current
      const t0 = this.current.t
      this.current.t += dt
      const dur = clip.duration
      if (clip.loop) {
        const w0 = t0 % dur
        const w1 = this.current.t % dur
        step = { t0: w0, t1: w1, wrapped: w1 < w0, duration: dur }
      } else {
        step = { t0: Math.min(t0, dur), t1: Math.min(this.current.t, dur), wrapped: false, duration: dur }
      }
    }

    let pose = this.currentPose()
    if (this.blendFrom && this.blendLeft > 0) {
      this.blendLeft -= dt
      const u = 1 - Math.max(0, this.blendLeft) / BLEND_TIME
      pose = lerpPose(this.blendFrom, pose, Math.min(1, u))
      if (this.blendLeft <= 0) this.blendFrom = null
    }
    this.apply(pose)
    return step
  }

  private apply(pose: Pose): void {
    for (const [name, bn] of this.built.nodes) {
      const o = pose.get(name)
      const { base } = bn
      if (!o) {
        bn.outer.position.copy(base.pos)
        bn.outer.rotation.copy(base.rot)
        bn.outer.scale.copy(base.scale)
        continue
      }
      bn.outer.position.set(base.pos.x + o.pos[0], base.pos.y + o.pos[1], base.pos.z + o.pos[2])
      bn.outer.rotation.set(
        base.rot.x + THREE.MathUtils.degToRad(o.rot[0]),
        base.rot.y + THREE.MathUtils.degToRad(o.rot[1]),
        base.rot.z + THREE.MathUtils.degToRad(o.rot[2]),
      )
      bn.outer.scale.set(base.scale.x * o.scale, base.scale.y * o.scale, base.scale.z * o.scale)
    }
  }
}
