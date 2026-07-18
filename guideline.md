# Guidelines

How this codebase is written. Rules land here as we decide them, class by class. A rule
belongs here only once we've hit the thing it prevents — this is not a style wishlist.

## Time

**Use `THREE.Timer`, never `THREE.Clock`.** `Clock` is deprecated since r183 and warns at
runtime (`Clock: This module has been deprecated. Please use THREE.Timer instead.`). In
three 0.185 `Timer` lives in core, so it is `new THREE.Timer()` — no addon import.

```ts
const timer = new THREE.Timer()
timer.connect(document)

const frame = (timestamp: number): void => {
  timer.update(timestamp)          // advance ONCE per step, before any read
  const dt = Math.min(0.05, timer.getDelta())
  ...
}
```

Three things that differ from `Clock` and will bite if assumed:

- **`getDelta()` is a pure read.** `update()` advances; `getDelta()` can be called any number
  of times per step and returns the same value. `Clock.getDelta()` was self-consuming — the
  second caller in a frame silently got ~0. Code that *relied* on that (e.g. two drivers
  sharing one clock and trusting it to not double-advance) is wrong against `Timer`: with
  `Timer`, whoever calls `update()` twice in a frame advances time twice. **One `update()`
  per step, one owner.**
- **No max-delta.** `Timer` in this version has no clamp of its own, so clamp at the call
  site. A stall must not teleport the world.
- **`connect(document)` is opt-in.** It enables the Page Visibility API, so a hidden tab
  yields `dt` 0 rather than one huge delta on return. The corollary: while the tab is
  hidden nothing advances — if frames are ever driven while hidden (screenshots, capture),
  that path gets no time and must not expect any.

`update(timestamp)` takes the `requestAnimationFrame` timestamp. Pass it; without it Timer
falls back to `performance.now()`, which is a second, slightly different clock.

## Comments

**A comment explains the code as it is now.** It is read by someone who has no idea what the
code used to look like, and does not care. Write for that reader.

- **Never write change history.** No "now a tag", "still hardcoded", "pre-existing", "moved
  from X", "was Y before". Git holds that. A comment that only makes sense if you watched the
  diff is noise the day after it is written.
- **Keep them short.** One line where one line does. If a comment needs a paragraph to justify
  the code, the code usually wants fixing instead.
- **Explain *why*, not *what*.** The code already says what it does.

**Multi-line comments use `/* */`, never a stack of `//`.**

```ts
/*
 A component is an object reference; bitECS tracks membership and we own the storage.
 Numeric data goes in parallel arrays, object refs in a plain array, tags carry nothing.
*/
export const Position = { x: [] as number[], y: [] as number[], z: [] as number[] }
```

Single-line `//` stays for a single line — including trailing notes on a line of code.

## Functions

**Prefer arrow functions.** Module-level helpers and callbacks are `const fn = () => {}`, not
`function fn() {}` — one form, hoisting never in play.

```ts
const writeVec3 = (store: Vec3Store, eid: number, v: Vec3): void => { ... }
```

Class methods stay methods. The exception is a method used as a detached callback
(`addEventListener(this.onResize)`), which must be a class-property arrow to keep `this`.
