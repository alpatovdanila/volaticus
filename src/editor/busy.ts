// Editor-wide LOCKING busy indicator — ONE overlay for every long operation (entity
// builds, lineup batching, geometry re-bakes, inventory load, shader compiles), instead
// of per-spot spinners. Full-screen scrim + spinner + label, sitting above everything
// (modals included), and it swallows input while shown so a half-built doc can't be
// edited mid-operation.
//
// REF-COUNTED with per-handle ownership: each operation start()s its own handle and
// end()s it in a `finally` — overlapping operations compose (the overlay hides when the
// LAST one ends), a superseded/failed operation can never strand the overlay, and there
// is no token juggling. The label shown is the most recently started (or updated)
// operation's — the one the user just triggered.
const active = new Map<number, string>()
let nextId = 1
let overlay: HTMLDivElement | null = null
let labelEl: HTMLDivElement | null = null

function ensureDom(): void {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.id = 'busy-veil'
  overlay.hidden = true
  const spin = document.createElement('div')
  spin.className = 'busy-spin'
  labelEl = document.createElement('div')
  labelEl.className = 'busy-label'
  overlay.appendChild(spin)
  overlay.appendChild(labelEl)
  document.body.appendChild(overlay)
}

function render(): void {
  if (!overlay || !labelEl) return
  if (active.size === 0) {
    overlay.hidden = true
    return
  }
  labelEl.textContent = [...active.values()][active.size - 1] // latest started/updated
  overlay.hidden = false
}

export interface BusyHandle {
  update(label: string): void // narrate progress ("building 12/44…") — no re-count
  end(): void // idempotent; call from a finally
}

export function startBusy(label: string): BusyHandle {
  ensureDom()
  const id = nextId++
  active.set(id, label)
  render()
  let ended = false
  return {
    update(l: string): void {
      if (ended) return
      active.delete(id) // re-insert so this handle becomes the latest (shown) label
      active.set(id, l)
      render()
    },
    end(): void {
      if (ended) return
      ended = true
      active.delete(id)
      render()
    },
  }
}
