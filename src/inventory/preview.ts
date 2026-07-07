// Presentation-level state machine: drives anims, show/hide, enter bindings,
// timeline cues, ambient sfx and despawn. Transition *logic* (when a state
// changes) belongs to game behavior code / the editor UI — not here.
import * as THREE from 'three'
import { AnimPlayer } from './anim'
import type { BuiltEntity } from './factory'
import { catalogColorPath, catalogDefaultTint } from './materials'
import {
  effectIdOf,
  effectParamsOf,
  resolveBinding,
  resolveMaterials,
  statesOf,
  type Binding,
  type EntityDoc,
  type StateDef,
} from './schema'

export interface PreviewDeps {
  playSfx(id: string): void
  playEffect(id: string, at: THREE.Vector3, params?: { texture?: string; tint?: string }): void
  flash(hex: string): void
  shatter(): void
  onDespawn(): void
}

export class EntityPreview {
  readonly stateNames: string[]
  readonly modifierNames: string[]
  readonly initial: string | null
  private states: Record<string, StateDef>
  private anim: AnimPlayer
  private cueTimes: { t: number; binding: Binding }[] = []
  private ambient: { sfx: string; every: [number, number]; next: number } | null = null
  private despawnAt: number | null = null
  private stateTime = 0
  private overlayLeft: number | null = null // remaining time of a one-shot binding anim
  current: string | null = null
  // active entity-level modifier (face expression etc.) — visibility overlay
  // applied ON TOP of the state's show/hide, survives state changes
  modifier: string | null = null
  // game-provided modifiers (surface underfoot etc.); bindings resolve byContext against this
  context: Record<string, string> = {}

  constructor(
    private doc: EntityDoc,
    private built: BuiltEntity,
    private deps: PreviewDeps,
    opts?: { initialState?: string },
  ) {
    const { initial, states } = statesOf(doc)
    this.states = states
    this.stateNames = Object.keys(states)
    this.modifierNames = Object.keys(doc.modifiers ?? {})
    this.initial = initial
    this.anim = new AnimPlayer(built, doc.anims ?? {})
    // per-instance start-state override (instances.json initialState) — an
    // unknown name falls back to the doc's states.initial
    const start = opts?.initialState && states[opts.initialState] ? opts.initialState : initial
    if (start) this.setState(start, 0)
  }

  private effectOrigin(): THREE.Vector3 {
    const box = new THREE.Box3().setFromObject(this.built.group)
    if (box.isEmpty()) return this.built.group.getWorldPosition(new THREE.Vector3())
    return box.getCenter(new THREE.Vector3())
  }

  fireBinding(raw: Binding | undefined): void {
    if (!raw) return
    const b = resolveBinding(raw, this.context)
    if (b.sfx) this.deps.playSfx(b.sfx)
    const effectId = effectIdOf(b.effect)
    if (effectId) {
      const params = effectParamsOf(b.effect)
      // "slot" inherits the current texture+tint of one of this entity's material
      // slots — debris stays in sync when the object is retextured. Item 34: the
      // slot is RESOLVED first, so a slot that inherits its material/tint/uvRot
      // from a parent hands the debris the same values the surface renders with.
      if (typeof b.effect === 'object' && b.effect.slot) {
        const m = resolveMaterials(this.doc.materials)[b.effect.slot]
        if (m) {
          // slots reference a catalog material — inherit its color map as the debris texture
          const tex = m.material !== undefined ? catalogColorPath(m.material) : ''
          if (tex) params.texture = tex
          // effective tint: per-slot override wins, else the material's default
          // tint (from catalog tuning), else whatever the effect param already had
          params.tint = m.tint ?? (m.material !== undefined ? catalogDefaultTint(m.material) : undefined) ?? params.tint
          params.uvRot = m.uvRot ?? params.uvRot
        }
      }
      this.deps.playEffect(effectId, this.effectOrigin(), params)
    }
    if (b.anim) {
      const clip = this.doc.anims?.[b.anim]
      if (clip) {
        this.anim.play(b.anim, 0.05)
        this.overlayLeft = clip.duration
      }
    }
    if (b.flash) this.deps.flash(b.flash)
    if (b.shatter) this.deps.shatter()
    if (b.despawn) this.deps.onDespawn()
  }

  // visibility = defaults, then the state's show/hide, then the active
  // modifier's show/hide on top (so expressions combine with any state)
  private applyVisibility(): void {
    const st = this.current ? this.states[this.current] : undefined
    for (const bn of this.built.nodes.values()) bn.outer.visible = bn.defaultVisible
    for (const n of st?.show ?? []) { const bn = this.built.nodes.get(n); if (bn) bn.outer.visible = true }
    for (const n of st?.hide ?? []) { const bn = this.built.nodes.get(n); if (bn) bn.outer.visible = false }
    const mod = this.modifier ? this.doc.modifiers?.[this.modifier] : undefined
    for (const n of mod?.show ?? []) { const bn = this.built.nodes.get(n); if (bn) bn.outer.visible = true }
    for (const n of mod?.hide ?? []) { const bn = this.built.nodes.get(n); if (bn) bn.outer.visible = false }
  }

  // one modifier active at a time; null clears. Reapplied after state changes.
  setModifier(name: string | null): void {
    this.modifier = name && this.doc.modifiers?.[name] ? name : null
    this.applyVisibility()
  }

  setState(name: string, blend = 0.15): void {
    const st = this.states[name]
    if (!st) return
    this.current = name
    this.stateTime = 0
    this.applyVisibility()
    this.overlayLeft = null
    this.anim.play(st.anim ?? null, blend)
    this.cueTimes = Object.entries(st.cues ?? {})
      .map(([t, binding]) => ({ t: parseFloat(t), binding }))
      .sort((a, b) => a.t - b.t)
    this.ambient = st.ambient
      ? { sfx: st.ambient.sfx, every: st.ambient.every, next: this.randEvery(st.ambient.every) }
      : null
    this.despawnAt = st.despawnAfter ?? null
    this.fireBinding(st.enter)
  }

  fireEvent(name: string): void {
    this.fireBinding(this.doc.events?.[name])
  }

  // Offset the current state's LOOPING anim into a stable mid-cycle phase
  // (u = 0..1 of the clip duration) so identical entities de-sync. State/cue
  // timers stay anchored to spawn — only the loop clock shifts.
  setAnimPhase(u: number): void {
    this.anim.setPhase(u)
  }

  private randEvery(every: [number, number]): number {
    return every[0] + Math.random() * (every[1] - every[0])
  }

  update(dt: number): void {
    // one-shot overlay anim finished — resume the current state's clip (or base pose)
    if (this.overlayLeft !== null) {
      this.overlayLeft -= dt
      if (this.overlayLeft <= 0) {
        this.overlayLeft = null
        const stateAnim = this.current ? this.states[this.current]?.anim : undefined
        this.anim.play(stateAnim ?? null, 0.12)
      }
    }
    const step = this.anim.update(dt)
    // fire cues whose time was crossed this frame (handling loop wrap)
    for (const cue of this.cueTimes) {
      const crossed = step.wrapped
        ? cue.t > step.t0 || cue.t <= step.t1
        : cue.t > step.t0 && cue.t <= step.t1
      // also fire t=0 cues on the very first frame of the state
      const firstFrame = this.stateTime === 0 && cue.t === 0
      if (crossed || firstFrame) this.fireBinding(cue.binding)
    }
    this.stateTime += dt
    if (this.ambient) {
      this.ambient.next -= dt
      if (this.ambient.next <= 0) {
        this.deps.playSfx(this.ambient.sfx)
        this.ambient.next = this.randEvery(this.ambient.every)
      }
    }
    if (this.despawnAt !== null && this.stateTime >= this.despawnAt) {
      this.despawnAt = null
      this.deps.onDespawn()
    }
  }
}
