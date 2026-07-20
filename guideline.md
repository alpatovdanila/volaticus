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

- **Time-independent — no past, no future.** No "now a tag", "still hardcoded", "moved from X",
  "was Y before" — git holds that. And no "yet", "for now", "will be", "for when that day
  comes" — plans are not facts about this code. A comment that dates itself is wrong the day
  after it is written; history in a comment is justified almost never.

  ```
  Bad:  No `lifecycle` block yet: the player is level-placed and nothing stages a player
        death. The model ships Death/Hit clips for when that day comes.
  ```

- **Stay inside the module.** A comment does not reference another system's implementation
  details or absent features — the module's context stays pure and tightly composed. If the
  sentence is about how some other file behaves, it belongs in that file or nowhere.

  ```
  Bad:  Aim-locked movement is not a separate mode here
  ```

- **Components carry no service knowledge.** A component is abstract and generic (or private,
  in which case nobody reads it anyway); its comment cannot encode some service's
  implementation prejudice — which system gates on it, who counts it down, what the writer's
  timers do. That is the consumer's story, told at the consumer.

  ```
  Bad:  A clip that OWNS the animation channel while present — LocomotionAnimation is gated
        on its absence. ... ScriptedClips counts it down and removes it, so callers fire
        and forget; locomotion resumes by itself.
  ```

- **Say what it is, not how it behaves.** Identity and purpose, in the abstract — not runtime
  choreography. Meta-information — intersystem quirks, game-wide mechanics — goes in a
  separate overview document, not in a module's header.
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
