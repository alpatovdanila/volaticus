# DEATHTERRA — game systems architecture

Who calls whom, by what interface. `src/game/**` is the game; `src/inventory/**` +
`src/lib/**` is the shared engine (also consumed by the editor — changes there must
serve both hosts).

## The map

```mermaid
flowchart TD
  subgraph devices [device layer]
    INPUT["input.ts\npollMove(): MoveInput\n(gamepad / WASD / __stick)"]
  end

  subgraph game [game systems]
    MAIN["main.ts — composition root\nframe loop · camera · HUD · perf\ntarget proposal · hit routing"]
    PLAYER["player.ts PlayerController\nstance FSM (moving/settling/standing)\nupdate(dt, MoveInput, aim) · muzzle() · onShot"]
    LOCO["locomotion.ts Locomotion\nanalog phases idle/walk/run/fire\nLPM rate coupling · setFiring · faceToward"]
    PROJ["projectiles.ts Projectiles\nspawn(from, dir)\nupdate(dt, targets): {hits, walls}"]
    HORDE["zombies.ts Horde\nspawnAt(type, x, z, delay) · update(dt, playerPos)\nhit(obj): HitResult · targets()"]
    WAVES["waves.ts WaveController\nWaveDef → when/what/where\nupdate(dt) · status()"]
    REMAINS["remains.ts RemainsManager&lt;T&gt;\nadd · takeOldest · update (budgets)"]
    FXM["effectsManager.ts EffectsManager\nbloodHit(at) · wallSpark(at)\nper-category budgets"]
    SYS["system.ts registry\nsystem.params (live reads)"]
    TUNE["tuning.ts sliders\n+ window.__sys"]
  end

  subgraph engine [shared engine]
    FX["effects.ts EffectSystem\nbursts · chunk pools · capDismembered"]
    PREV["preview.ts EntityPreview\nstates · derived dismember events"]
    FACT["factory.ts buildGlbEntity\ngltf.ts loadGltfModel"]
    RIG["lighting.ts LightingRig\nmaterials.ts catalog"]
  end

  INPUT -- "MoveInput" --> MAIN
  MAIN -- "update(dt, move, aim)" --> PLAYER
  PLAYER --> LOCO
  LOCO -. "onShot (per fire loop)" .-> PLAYER
  PLAYER -. "onShot" .-> MAIN
  MAIN -- "spawn(muzzle, dir)" --> PROJ
  MAIN -- "targets()" --> HORDE
  MAIN -- "hits → hit(obj)" --> HORDE
  MAIN -- "hits/walls → blood/spark" --> FXM
  MAIN -- "update(dt)" --> WAVES
  WAVES -- "spawnAt / aliveCount" --> HORDE
  HORDE -- "add / takeOldest" --> REMAINS
  REMAINS -- "capDismembered" --> FX
  HORDE -- "build + drive" --> PREV
  HORDE --> FACT
  PREV -- "deps.dismember" --> FX
  FXM --> FX
  MAIN -- "applyParams · patchShadow" --> RIG
  TUNE -- "writes" --> SYS
  SYS -. "read live each frame" .-> PLAYER & LOCO & HORDE & MAIN
```

## Interfaces (the contracts that matter)

| System | Consumes | Provides | Notes |
|---|---|---|---|
| `input.ts` | devices | `MoveInput {x, y, mag}` | pure device layer; virtual stick slots in here |
| `PlayerController` | `MoveInput`, aim point | stance, `muzzle()`, `onShot` | ALL input interpretation lives here |
| `Locomotion` | mixer + clips | speed, fire-loop shots | LPM coupling, weight blending |
| `Projectiles` | targets `{object, point}[]` | `{hits, walls}` | segment-vs-sphere, instanced draw |
| `Horde` | docs, EffectSystem | `HitResult`, `targets()` | pool + AI + damage application |
| `WaveController` | `WaveDef`, Horde | wave state | data-driven; owns nothing visual |
| `RemainsManager<T>` | items + release fn | oldest-first custody | generic; budget policy in one place |
| `EffectsManager` | semantic calls | — | budgets/throttling; defs are `EffectDoc`s |
| `system.ts` | writes (tuning/upgrades) | `system.params` | read LIVE by consumers, never copied |

## SOLID review

- **SRP** — mostly tight. One flagged spot: `Horde` carries three responsibilities
  (instance pool, chase AI, damage/dismember application). Fine at one enemy type;
  when the second type lands, split into `EnemyPool` / per-type brains / a damage
  resolver. `main.ts` is intentionally procedural — it's the composition root; watch
  its size, not its style.
- **OCP** — waves are data (`WaveDef`), enemy types are data (`docs` record), effects
  are data (`EffectDoc`). New content shouldn't need new branches.
- **DIP** — the game depends on engine seams (`EffectSystem`, `EntityPreview`,
  `buildGlbEntity`) that the editor also exercises, so they stay honest.

## Event bus — not yet, and here's the trigger

Today the call graph is a shallow DAG where every arrow has exactly **one** consumer —
a bus would hide that flow without removing any coupling. The moment to introduce one
is the first real FAN-OUT: `enemyDied` is imminent (XP system + wave bookkeeping +
audio + UI will all care). When that lands: a small **typed** emitter (`events.ts`)
carrying gameplay FACTS only (`EnemyDied`, `WaveStarted`, `WaveCleared`), published by
Horde/WaveController. Frame-tick call chains stay direct calls — buses are for facts,
not for ticking.

## Instanced horde (the "tomorrow" plan)

Current per-entity path: each zombie = own skeleton clone + mixer (≈4 draws + shadow).
Fine to ~30–50 actors. The 100-enemy path (sketched in perf notes): bake all clips into
a bone-matrix DataTexture at load; ONE InstancedMesh per material for the whole horde;
TSL vertex skinning fetches bones from the texture; per-instance attributes carry
(clipIndex, phase, emissiveK, dismember mask). Loses mixer blending (hard switch or
2-slot crossfade in-shader). It forks the presentation path away from EntityPreview,
so we pay for it when profiling demands it — the pool/remains/registry seams are
already shaped for the swap.
