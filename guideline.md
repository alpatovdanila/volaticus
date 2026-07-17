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
