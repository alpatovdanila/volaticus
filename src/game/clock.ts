// THE SIM CLOCK — the only time source gameplay is allowed to read.
//
// The sim runs on a CLAMPED dt (a 300ms hitch advances the world by 50ms, so a stall can't
// teleport the horde through a wall). Wall-clock does not agree with that, and every
// mechanism that read `performance.now()` was quietly measuring a different timeline than
// the one it was supposed to be governing:
//
//   • the fire-rate gate, the stopping-power flinch window, the effect budgets
//   • the upgrade-pick screen (docs/GAME.md) is a pause by genre convention — under a
//     wall-clock pause the flinch expires, the fire gate elapses, and the shot you queued
//     goes off into the menu
//   • the hidden-tab interval driver already ticks sim frames at a different real-time
//     density than rAF does
//
// So: ONE accumulator, ticked once per frame in main's frame(), read as `sim.now`
// everywhere else. Pausing is simply not ticking it — there is no pause flag to forget.
//
// Two things deliberately stay on WALL-CLOCK, and must not be "fixed":
//   • the audio MIN_GAP (audio.ts) — it protects the listener's ear from same-instant
//     doubles; that's a real-world concern, and it must keep working while paused
//   • the dev hit log (combat.ts) — a human reads it against their own stopwatch
class GameClock {
  private t = 0

  // advance the sim by one frame's clamped dt. Called EXACTLY once per frame, by main.
  tick(dt: number): void {
    this.t += dt
  }

  // seconds of simulated time since the run began
  get now(): number {
    return this.t
  }

  // new run / new session
  reset(): void {
    this.t = 0
  }
}

export const sim = new GameClock()
