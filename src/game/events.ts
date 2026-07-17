// Gameplay facts — the one way systems tell each other what HAPPENED.
//
// A fact is past tense and blame-free: the Horde reports that an enemy died, it does not
// ask anyone to play a sound, spray blood, or charge the ultimate. Everything that wants to
// react subscribes. This is what replaced three coexisting fan-out conventions (an injected
// sfx closure, an inline dispatch block in the frame loop, and a single-slot callback that
// nothing ever assigned), and it's why adding XP, quests or damage numbers tomorrow is a
// subscriber rather than another edit to the frame loop.
//
// SYNCHRONOUS by design — emit() runs its subscribers before it returns, so a fact lands in
// exactly the frame (and the frame ORDER) it was produced in. No queue, no deferral, no
// "next frame" surprises: the sim stays as deterministic as the hand-written calls it
// replaced. That also means a subscriber must not be slow, and must not emit a fact that
// loops back to its own producer.
//
// The union below is CLOSED: a new fact means a new entry here, so the vocabulary is one
// readable list and TypeScript finds every subscriber that needs to care.
import type * as THREE from 'three'

// Vector payloads are BORROWED for the duration of the emit call — subscribers that keep
// one past the call must copy it. (Producers reuse buffers; nothing is cloned per fact.)
export interface GameFacts {
  // one trigger pull (not one pellet — a shotgun blast is a single shotFired)
  shotFired: { muzzle: THREE.Vector3; dir: THREE.Vector3; pellets: number }
  // an enemy has broken ground and is entering the fight (not when it was queued — when
  // the player can first see and hear it)
  enemySpawned: { kind: string; at: THREE.Vector3 }
  // a bolt landed on an enemy. `kind` is the gameplay species (see enemies.ts), `hp` is
  // what's left, `severed` names the part this hit tore off (null = none)
  enemyHit: { kind: string; at: THREE.Vector3; dir: THREE.Vector3; hp: number; severed: string | null }
  // …and that hit finished it. Emitted in addition to enemyHit, never instead of it.
  enemyDied: { kind: string; at: THREE.Vector3; wave: number }
  wallHit: { at: THREE.Vector3 } // a bolt stopped on arena geometry
  waveStarted: { n: number }
  waveCleared: { n: number }
}

export type FactName = keyof GameFacts
type Handler<K extends FactName> = (fact: GameFacts[K]) => void

export class GameEvents {
  private subs = new Map<FactName, Handler<FactName>[]>()

  // subscribe; returns an unsubscribe fn. NOBODY CALLS IT YET — there is no arena session,
  // and all six subscribe sites discard the disposer, which is correct while every
  // subscriber outlives the process. It exists for the session that will need it.
  on<K extends FactName>(name: K, fn: Handler<K>): () => void {
    const list = this.subs.get(name) ?? []
    list.push(fn as Handler<FactName>)
    this.subs.set(name, list)
    return () => {
      const i = list.indexOf(fn as Handler<FactName>)
      if (i >= 0) list.splice(i, 1)
    }
  }

  // report a fact. Subscribers run in subscription order, synchronously, before this
  // returns. A throwing subscriber must not take the frame (or its fellow subscribers)
  // down with it — the game keeps running and the fault is reported once, loudly.
  emit<K extends FactName>(name: K, fact: GameFacts[K]): void {
    const list = this.subs.get(name)
    if (!list) return
    for (const fn of list.slice()) {
      // slice: a subscriber may unsubscribe during dispatch
      try {
        ;(fn as Handler<K>)(fact)
      } catch (err) {
        console.error(`events: subscriber of "${name}" threw`, err)
      }
    }
  }
}
