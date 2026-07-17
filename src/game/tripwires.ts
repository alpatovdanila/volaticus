// Boot tripwires — the rules that are otherwise enforced by nothing but a comment.
//
// This stack has a handful of ordering contracts whose violation is both silent and
// expensive, and which every one of these files currently just *asks* you to respect:
//
//   • every light must exist before the first render. r185 bakes the scene's light COUNT
//     into every pipeline, so adding one later rebuilds all of them — and under the MRT
//     post chain it can poison the ShadowMaterial pipeline and black the canvas out
//     permanently, with no error and no recovery.
//   • materials must be built after the catalog loads, or they're untextured forever.
//
// Both surface hours later looking like "the renderer broke". A comment can't catch that;
// a named error at the moment of the violation can. These are deliberately cheap — a
// shallow count, once a second — because their whole job is to be always-on.

let rendered = false

// main calls this once the first frame has been submitted
export function markFirstRender(): void {
  rendered = true
}

export function hasRendered(): boolean {
  return rendered
}

// A light created after the first frame is the violation this whole pooling design exists
// to prevent. Returns a check to call periodically; it baselines itself on the first call
// after the first render, then reports any change once.
export function watchLightCount(scene: THREE_SceneLike): () => void {
  const count = (): number => {
    let n = 0
    scene.traverse((o) => {
      if (o.type.endsWith('Light')) n++
    })
    return n
  }
  let expected = -1
  return () => {
    if (!rendered) return
    const n = count()
    if (expected < 0) {
      expected = n // baseline: the set as it stood at the first frame
      return
    }
    if (n === expected) return
    console.error(
      `TRIPWIRE — light count changed after the first render: ${expected} → ${n}. r185 bakes the light count ` +
        `into every pipeline, so this rebuilds all of them; under the post chain it can black out the canvas for ` +
        `good. Every light must be created at boot — see LightPool, and EffectSystem's flash provider (main.ts).`,
    )
    expected = n // report each change once, then track the new baseline
  }
}

// structural, so this module needn't import three
interface THREE_SceneLike {
  traverse(fn: (o: { type: string }) => void): void
}
