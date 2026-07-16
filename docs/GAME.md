# DEATHTERRA — game design

Archero-style arena shooter. This document is the north star; the editor/inventory pipeline
(imported GLB models, dismemberment, effects) feeds it content.

## Core loop

- The player enters an **arena room**. **Waves of enemies** spawn.
- Player controls **movement only** — aiming and shooting are **automatic**, and firing
  requires **standing still** (move-or-shoot tension is the core decision).
- Killing enemies grants **XP** → levels. Each level offers an **upgrade**: fire rate,
  fire damage, ricocheting bullets, piercing, multishot, etc.
- **ULTIMATES** — the twist. Charged over time/by kills, manually activated for satisfying
  devastation (orbital strike, etc.). Big VFX payoff moments.
- When the wave is cleared, a **door** to the next room opens; the player progresses.
- **Bosses** (one or several) every ~5–10 rooms.

## Controls

- Mobile-first: virtual stick. Full support for **gamepads** and bigger screens.
- Analog locomotion: stick deflection 0→½ = walk (variable speed), ½→1 = run (variable
  speed), max speed at full deflection. Animations scale playback speed inside each phase
  and crossfade between phases.
- Stationary → idle → auto-acquire nearest target → auto-fire (stationary only).

## Targets

- **Performance**: insanely well optimized. Hundreds of enemies per scene; models kept
  <500 tris; instanced debris (severed parts = 1 draw call per part type); baked-bone-texture
  instanced hordes when the runtime needs it (see volaticus perf notes).
- **Platforms**: mobile browsers/wrappers first; desktop + gamepad first-class.

## Monetization (planned, not built)

- Resurrect for in-game currency; ads for benefits (the usual mobile loops).
- Donations / IAP. Design later; keep hooks in mind (currency, run state, revive points).

## Milestones

1. **Testing grounds** (dev-only level): simple arena (walls + solid floor), player
   movement controller (analog walk/run with animation phase blending), auto-aim +
   auto-fire when stationary, glowing-stick projectiles. ← current
2. Enemies: wave spawner, chase/attack AI, HP/death (death anims + dismember/shatter payoffs).
3. XP/levels/upgrade picker.
4. Ultimates (orbital strike first).
5. Rooms/doors/progression; bosses.
6. Mobile input + HUD; perf hardening; monetization hooks.
