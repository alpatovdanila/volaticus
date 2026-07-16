// Presentation-level state machine: drives anims, show/hide, enter bindings,
// timeline cues, ambient sfx and despawn. Transition *logic* (when a state
// changes) belongs to game behavior code / the editor UI — not here.
import * as THREE from 'three'
import { AnimPlayer } from './anim'
import type { BuiltEntity } from './factory'
import { catalogColorPath } from './materials'
import {
  effectIdOf,
  effectParamsOf,
  isScriptEffect,
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
  shatter(): void // effect === SCRIPT_EFFECT_SHATTER — throw the entity's parts apart
  // effect === SCRIPT_EFFECT_DISMEMBER — sever + throw one named mesh part; weight
  // (model.dismember[part].weight, default 1) scales the throw: velocity ∝ 1/weight
  dismember(part: string, weight: number): void
  // a "dismembered_<part>" modifier was deactivated — the part is visible again, so the
  // host should despawn its severed ground chunk (limb and chunk never coexist)
  onPartRestored?(part: string): void
  hideGeometry(): void // binding.hideGeometry — hide the main mesh (reaction); instance stays
  onDespawn(): void // state.despawnAfter — the runtime removes the instance
}

export class EntityPreview {
  readonly stateNames: string[]
  readonly initial: string | null
  private states: Record<string, StateDef>
  private anim?: AnimPlayer // procedural path; undefined for an imported GLB (mixer path)
  private mixer?: THREE.AnimationMixer // imported GLB: drives the model's own skeleton
  private clipsByName?: Map<string, THREE.AnimationClip>
  private currentAction?: THREE.AnimationAction
  private overlayAction?: THREE.AnimationAction // one-shot reaction clip riding over the state clip
  private pending: { left: number; run: () => void }[] = [] // delayed binding consequences (effect.delay)
  private cueTimes: { t: number; binding: Binding }[] = []
  private ambient: { sfx: string; every: [number, number]; next: number } | null = null
  private despawnAt: number | null = null
  private stateTime = 0
  private overlayLeft: number | null = null // remaining time of a one-shot binding anim
  current: string | null = null
  // active entity-level modifiers (face expression, severed parts…) — visibility overlays
  // applied ON TOP of the state's show/hide; STACKABLE, survive state changes
  readonly activeModifiers = new Set<string>()
  // game-provided modifiers (surface underfoot etc.); bindings resolve byContext against this
  context: Record<string, string> = {}

  // Declared + DERIVED names, computed live from the doc (the editor edits model.dismember
  // in place — new checkboxes surface here without a rebuild). Every model.dismember part
  // gets a virtual "dismembered_<part>" modifier and "dismember_<part>" event for free.
  get modifierNames(): string[] {
    const declared = Object.keys(this.doc.modifiers ?? {})
    const derived = Object.keys(this.doc.model?.dismember ?? {}).map((p) => `dismembered_${p}`)
    return [...declared, ...derived.filter((d) => !declared.includes(d))]
  }
  get eventNames(): string[] {
    const declared = Object.keys(this.doc.events ?? {})
    const derived = Object.keys(this.doc.model?.dismember ?? {}).map((p) => `dismember_${p}`)
    return [...declared, ...derived.filter((d) => !declared.includes(d))]
  }

  constructor(
    private doc: EntityDoc,
    private built: BuiltEntity,
    private deps: PreviewDeps,
    opts?: { initialState?: string },
  ) {
    const { initial, states } = statesOf(doc)
    this.states = states
    if (built.mixer) {
      // IMPORTED GLB: play the model's own AnimationClips via its mixer (NOT AnimPlayer,
      // which would clobber the mesh transforms each frame — the mixer drives the bones).
      this.mixer = built.mixer
      this.clipsByName = new Map((built.clips ?? []).map((c) => [c.name, c]))
      // states (if authored) map name→clip; with no states, expose the clips as states.
      this.stateNames = Object.keys(states).length ? Object.keys(states) : [...this.clipsByName.keys()]
      this.initial = initial ?? this.stateNames[0] ?? null
    } else {
      this.stateNames = Object.keys(states)
      this.initial = initial
      this.anim = new AnimPlayer(built, doc.anims ?? {})
    }
    // per-instance start-state override (instances.json initialState) — an
    // unknown name falls back to the doc's states.initial
    const start = opts?.initialState && this.stateNames.includes(opts.initialState) ? opts.initialState : this.initial
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
    // The effect + modifier flip are the reaction's CONSEQUENCE — optionally held back by
    // effect.delay (seconds) so the binding's anim (a flinch) can lead before the visible
    // detach/debris. Queued on the preview's own clock (update ticks it), so a rebuild or
    // entity switch drops the pending consequence with the preview instance — no timer leaks.
    const consequence = (): void => {
      const effectId = effectIdOf(b.effect)
      if (isScriptEffect(effectId)) {
        // reserved built-in script effect (resolved here, not looked up in inventory/effects/)
        if (effectId === 'SCRIPT_EFFECT_SHATTER') this.deps.shatter()
        else if (effectId === 'SCRIPT_EFFECT_DISMEMBER') {
          const part = typeof b.effect === 'object' ? b.effect.part : undefined
          if (part) this.deps.dismember(part, this.doc.model?.dismember?.[part]?.weight ?? 1)
        }
      } else if (effectId) {
        const params = effectParamsOf(b.effect)
        // "slot" inherits the current texture of one of this entity's material slots —
        // debris stays in sync when the object is retextured. Item 34: the slot is
        // RESOLVED first, so a slot that inherits its material/uvRot from a parent hands
        // the debris the same values the surface renders with.
        if (typeof b.effect === 'object' && b.effect.slot) {
          const m = resolveMaterials(this.doc.materials)[b.effect.slot]
          if (m) {
            // slots reference a catalog material — inherit its color map as the debris texture
            const tex = m.material !== undefined ? catalogColorPath(m.material) : ''
            if (tex) params.texture = tex
            params.uvRot = m.uvRot ?? params.uvRot
          }
        }
        this.deps.playEffect(effectId, this.effectOrigin(), params)
      }
      // reactions can flip an entity modifier ON (e.g. dismember → "dismembered_lhand" hides
      // the severed part across ALL later states). '' clears every active modifier.
      if (b.modifier !== undefined) {
        if (b.modifier) this.toggleModifier(b.modifier, true)
        else this.clearModifiers()
      }
    }
    const delay = typeof b.effect === 'object' ? (b.effect.delay ?? 0) : 0
    if (delay > 0) this.pending.push({ left: delay, run: consequence })
    else consequence()
    if (b.anim) {
      if (this.mixer && this.clipsByName?.has(b.anim)) {
        // IMPORTED GLB: play the clip ONCE as an overlay; update() crossfades back to the
        // current state's clip when it ends (mirrors the procedural overlay behaviour).
        const clip = this.clipsByName.get(b.anim)!
        const action = this.mixer.clipAction(clip)
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
        action.reset().play()
        if (this.currentAction && this.currentAction !== action) this.currentAction.crossFadeTo(action, 0.08, false)
        this.overlayAction = action
        this.overlayLeft = clip.duration
      } else {
        const clip = this.doc.anims?.[b.anim]
        if (clip) {
          this.anim?.play(b.anim, 0.05)
          this.overlayLeft = clip.duration
        }
      }
    }
    if (b.hideGeometry) this.deps.hideGeometry()
  }

  // visibility = defaults, then the state's show/hide, then every ACTIVE modifier's
  // show/hide on top, in activation order (so expressions/severed parts combine freely)
  private applyVisibility(): void {
    const st = this.current ? this.states[this.current] : undefined
    for (const bn of this.built.nodes.values()) bn.outer.visible = bn.defaultVisible
    for (const n of st?.show ?? []) { const bn = this.built.nodes.get(n); if (bn) bn.outer.visible = true }
    for (const n of st?.hide ?? []) { const bn = this.built.nodes.get(n); if (bn) bn.outer.visible = false }
    for (const name of this.activeModifiers) {
      const mod = this.modifierDef(name)
      for (const n of mod?.show ?? []) { const bn = this.built.nodes.get(n); if (bn) bn.outer.visible = true }
      for (const n of mod?.hide ?? []) { const bn = this.built.nodes.get(n); if (bn) bn.outer.visible = false }
    }
  }

  // a modifier's show/hide: declared in doc.modifiers, or DERIVED — "dismembered_<part>"
  // hides that mesh for any model.dismember part (no doc authoring needed)
  private modifierDef(name: string): { show?: string[]; hide?: string[] } | undefined {
    const declared = this.doc.modifiers?.[name]
    if (declared) return declared
    const part = /^dismembered_(.+)$/.exec(name)?.[1]
    return part && this.doc.model?.dismember?.[part] ? { hide: [part] } : undefined
  }

  // Modifiers STACK — severed left + severed right + a face expression can all be active.
  // Deactivating is fully reversible: the part re-shows via applyVisibility, and a derived
  // dismembered_<part> tells the host so the severed ground chunk can despawn.
  toggleModifier(name: string, active: boolean): void {
    if (active) {
      if (!this.modifierDef(name)) return
      this.activeModifiers.add(name)
    } else {
      if (!this.activeModifiers.delete(name)) return
      // raw regex (no map gate): the doc entry may have been unchecked just before this
      const part = /^dismembered_(.+)$/.exec(name)?.[1]
      if (part) this.deps.onPartRestored?.(part)
    }
    this.applyVisibility()
  }

  clearModifiers(): void {
    for (const name of [...this.activeModifiers]) this.toggleModifier(name, false)
  }

  setState(name: string, blend = 0.15): void {
    if (this.mixer) return this.setGlbState(name, blend)
    const st = this.states[name]
    if (!st) return
    this.current = name
    this.stateTime = 0
    this.applyVisibility()
    this.overlayLeft = null
    this.anim?.play(st.anim ?? null, blend)
    this.cueTimes = Object.entries(st.cues ?? {})
      .map(([t, binding]) => ({ t: parseFloat(t), binding }))
      .sort((a, b) => a.t - b.t)
    this.ambient = st.ambient
      ? { sfx: st.ambient.sfx, every: st.ambient.every, next: this.randEvery(st.ambient.every) }
      : null
    this.despawnAt = st.despawnAfter ?? null
    this.fireBinding(st.enter)
  }

  // IMPORTED GLB state change: `name` is an authored state (→ its clip) or a clip name
  // directly. Crossfade the mixer to that clip; still apply any show/hide on the meshes.
  private setGlbState(name: string, blend: number): void {
    const st = this.states[name]
    this.current = name
    this.stateTime = 0
    this.applyVisibility()
    // a manual state change cancels any running one-shot overlay
    if (this.overlayAction) {
      this.overlayAction.fadeOut(0.1)
      this.overlayAction = undefined
      this.overlayLeft = null
    }
    const clip = this.clipsByName?.get(st?.anim ?? name)
    if (clip && this.mixer) {
      const next = this.mixer.clipAction(clip)
      next.setLoop(THREE.LoopRepeat, Infinity)
      next.reset().play()
      if (this.currentAction && this.currentAction !== next) this.currentAction.crossFadeTo(next, Math.max(0.02, blend), false)
      this.currentAction = next
    }
    if (st?.enter) this.fireBinding(st.enter) // reactions (effects/sfx/dismember) fire on state entry
  }

  fireEvent(name: string): void {
    const declared = this.doc.events?.[name]
    if (declared) return this.fireBinding(declared)
    // DERIVED event: "dismember_<part>" for any model.dismember part — sever + throw the
    // chunk (weight-scaled) and activate the matching derived modifier. Zero doc authoring.
    const part = /^dismember_(.+)$/.exec(name)?.[1]
    if (part && this.doc.model?.dismember?.[part])
      this.fireBinding({ effect: { id: 'SCRIPT_EFFECT_DISMEMBER', part }, modifier: `dismembered_${part}` })
  }

  // Offset the current state's LOOPING anim into a stable mid-cycle phase
  // (u = 0..1 of the clip duration) so identical entities de-sync. State/cue
  // timers stay anchored to spawn — only the loop clock shifts.
  setAnimPhase(u: number): void {
    this.anim?.setPhase(u)
  }

  private randEvery(every: [number, number]): number {
    return every[0] + Math.random() * (every[1] - every[0])
  }

  update(dt: number): void {
    // delayed binding consequences (effect.delay) — ticked on the preview clock so they fire
    // for BOTH the mixer (GLB) and procedural paths, and die with the preview on rebuild
    if (this.pending.length) {
      for (const p of this.pending) p.left -= dt
      const ready = this.pending.filter((p) => p.left <= 0)
      if (ready.length) {
        this.pending = this.pending.filter((p) => p.left > 0)
        for (const p of ready) p.run()
      }
    }
    if (this.mixer) {
      // IMPORTED GLB: the mixer advances the model's own clips (drives the skeleton).
      this.mixer.update(dt)
      this.stateTime += dt
      // one-shot overlay (reaction clip) finished — crossfade back to the state's clip
      if (this.overlayLeft !== null) {
        this.overlayLeft -= dt
        if (this.overlayLeft <= 0) {
          this.overlayLeft = null
          const stateClip = this.current ? this.clipsByName?.get(this.states[this.current]?.anim ?? this.current) : undefined
          if (stateClip) {
            const next = this.mixer.clipAction(stateClip)
            next.setLoop(THREE.LoopRepeat, Infinity)
            next.reset().play()
            this.overlayAction?.crossFadeTo(next, 0.15, false)
            this.currentAction = next
          } else {
            this.overlayAction?.fadeOut(0.15)
          }
          this.overlayAction = undefined
        }
      }
      return
    }
    // one-shot overlay anim finished — resume the current state's clip (or base pose)
    if (this.overlayLeft !== null) {
      this.overlayLeft -= dt
      if (this.overlayLeft <= 0) {
        this.overlayLeft = null
        const stateAnim = this.current ? this.states[this.current]?.anim : undefined
        this.anim?.play(stateAnim ?? null, 0.12)
      }
    }
    const step = this.anim?.update(dt) ?? { t0: 0, t1: 0, wrapped: false, duration: 1 }
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
