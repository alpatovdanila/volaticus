// Page-scoped dev reloads (see the scopedReload plugin in vite.config.ts).
// The dev server suppresses vite's global full-reload broadcast for src/*.ts
// changes and instead announces the changed file; each page registers the
// prefixes that can affect it and reloads only for those. This is what lets
// the user keep working on assets in the inventory studio while Claude (or a
// build agent) edits level/game code — the pages no longer reload each other.
export function scopeHmrReloads(prefixes: string[], guard?: () => true | string): void {
  if (!import.meta.hot) return
  import.meta.hot.on('volaticus:src-change', (data: { file: string }) => {
    if (!prefixes.some((p) => data.file.startsWith(p))) return
    if (guard) {
      const verdict = guard()
      if (verdict !== true) {
        console.info(`[hmr] code change in ${data.file} — reload held: ${verdict}`)
        return
      }
    }
    location.reload()
  })
}
