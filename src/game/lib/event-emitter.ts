// A minimal event emitter. Each system owns one and exposes typed onX() methods over it.
// on/once return a disposer, so a caller can unsubscribe without keeping the handler.
type Handler = (...args: any[]) => void

interface Entry {
  fn: Handler
  once: boolean
  removed: boolean
}

export class EventEmitter {
  private entries = new Map<string, Entry[]>()

  on(event: string, fn: Handler): () => void {
    return this.add(event, fn, false)
  }

  once(event: string, fn: Handler): () => void {
    return this.add(event, fn, true)
  }

  off(event: string, fn: Handler): void {
    const list = this.entries.get(event)
    if (!list) return
    const i = list.findIndex((e) => e.fn === fn)
    if (i === -1) return
    list[i].removed = true // an emit already in flight holds a copy — this is how it finds out
    list.splice(i, 1)
    if (list.length === 0) this.entries.delete(event)
  }

  emit(event: string, ...args: any[]): void {
    const list = this.entries.get(event)
    if (!list) return
    // Dispatch from a copy so a handler may on()/off() mid-emit without the loop
    // skipping a sibling or re-entering. `removed` covers the other half: a handler
    // unsubscribed mid-emit must not still be called out of the copy.
    for (const entry of [...list]) {
      if (entry.removed) continue
      if (entry.once) this.off(event, entry.fn)
      entry.fn(...args)
    }
  }

  private add(event: string, fn: Handler, once: boolean): () => void {
    let list = this.entries.get(event)
    if (!list) {
      list = []
      this.entries.set(event, list)
    }
    list.push({ fn, once, removed: false })
    return () => this.off(event, fn)
  }
}
