// Pretty-printer matching the hand-authored style: objects go multi-line,
// arrays of primitives (incl. nested numeric pairs like anim keys) stay inline.
// Keeps editor saves diff-friendly and easy to read/edit by prompt.
export function stringifyPretty(value: unknown, indent = 2): string {
  const inlineable = (arr: unknown[]): boolean =>
    arr.every(
      (v) =>
        v === null ||
        typeof v === 'number' ||
        typeof v === 'string' ||
        typeof v === 'boolean' ||
        (Array.isArray(v) && inlineable(v)),
    )
  const inline = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']'
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
    if (entries.length === 0) return '{}'
    return '{ ' + entries.map(([k, x]) => JSON.stringify(k) + ': ' + inline(x)).join(', ') + ' }'
  }
  const enc = (v: unknown, depth: number): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    const pad = ' '.repeat(depth * indent)
    const padIn = ' '.repeat((depth + 1) * indent)
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]'
      if (inlineable(v)) return '[' + v.map((x) => enc(x, 0)).join(', ') + ']'
      return '[\n' + v.map((x) => padIn + enc(x, depth + 1)).join(',\n') + '\n' + pad + ']'
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
    if (entries.length === 0) return '{}'
    const flat = inline(v)
    if (flat.length + depth * indent <= 110) return flat
    return (
      '{\n' + entries.map(([k, x]) => padIn + JSON.stringify(k) + ': ' + enc(x, depth + 1)).join(',\n') + '\n' + pad + '}'
    )
  }
  return enc(value, 0) + '\n'
}
