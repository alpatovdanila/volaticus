// Remains manager — takes CUSTODY of battlefield leftovers (corpses, severed chunks)
// so nothing else has to care about their lifetime. The wave controller just stops
// referencing what died; this manager keeps the battlefield dressed within budgets
// and evicts the OLDEST remains when over. It is also the instance pool's back door:
// when the horde needs a body and the free pool is dry, it takes the oldest corpse
// back from here (despawn-by-reuse — the cheapest despawn there is).
import type { EffectSystem } from '../inventory/effects'

const MAX_CORPSES = 72 // corpses beyond this get evicted oldest-first
const MAX_CHUNKS = 60 // severed-part chunks (instances across the shared pools)

export class RemainsManager<T> {
  private corpses: T[] = [] // insertion order = age order

  constructor(
    private effects: EffectSystem,
    private release: (item: T) => void, // evict: hide + hand back to the instance pool
  ) {}

  // transfer custody of a fresh corpse (called when something dies)
  add(item: T): void {
    this.corpses.push(item)
  }

  // the instance pool reclaims the oldest matching corpse when it runs dry
  takeOldest(match: (item: T) => boolean): T | null {
    const i = this.corpses.findIndex(match)
    if (i < 0) return null
    const [item] = this.corpses.splice(i, 1)
    return item
  }

  update(): void {
    while (this.corpses.length > MAX_CORPSES) this.release(this.corpses.shift()!)
    this.effects.capDismembered(MAX_CHUNKS)
  }

  count(): number {
    return this.corpses.length
  }
}
