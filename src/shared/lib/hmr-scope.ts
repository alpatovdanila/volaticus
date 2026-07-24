// Guarded dev reloads (see the scopedReload plugin in vite.config.ts). The dev
// server suppresses vite's global full-reload broadcast for src/*.ts changes and
// instead announces the changed file; the studio registers the prefixes that affect
// it and, via the guard, HOLDS the reload while there are unsaved slot edits (a
// reload would nuke them) — otherwise it reloads.
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
