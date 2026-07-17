// Enemy horde — enemy instances + the instance POOL the wave controller draws from.
// A dead enemy isn't destroyed: once its death animation finishes the corpse is baked into
// the CorpseBatch and the skinned entity is parked, so the next spawnAt() re-dresses it
// (reset hp/state/position, restore severed parts via the reversible dismemberment
// modifiers, restore the crystal glow). Building a fresh skeleton clone only happens when
// the pool runs dry — that keeps wave N+1 free of build hitches and is the seam where true
// instanced hordes (baked-bone-texture, ~100 enemies) plug in later.
//
// MULTI-TYPE: everything species-specific is data (see enemies.ts EnemyDef) — hit points,
// aim height, body radius, gameplay kind, and clip NAMES. Per-type derived clip data
// (durations, the walk clip + its root-motion profile) is cached in a TypeRuntime record,
// NOT in Horde fields: two species must not overwrite each other's timing.
//
// IDENTITY: enemies are addressed by a stable numeric id, freshly minted on every re-dress.
// A recycled body therefore cannot be confused with its previous life by anything holding a
// handle across frames (see targeting.ts), and hit() is an O(1) map lookup.
//
// Presentation runs through the SAME EntityPreview + derived-dismemberment machinery
// as the editor: a landed hit rolls system.params.dismemberChance and fires the derived
// `dismember_<part>` event → severed chunk into the shared instanced pools + reversible
// `dismembered_<part>` modifier. Identical code path, shared chunk draw calls.
import * as THREE from 'three'
import { EntityPreview } from '../inventory/preview'
import { buildGlbEntity, type BuiltEntity } from '../inventory/factory'
import { loadGltfModel, type RootMotionProfile } from '../inventory/gltf'
import type { EffectSystem } from '../inventory/effects'
import type { GameEvents } from './events'
import type { EnemyDef } from './enemies'
import type { CorpseBatch } from './corpses'
import { LightPool } from './lights'
import { pushCircleOut, navigateAround, type Box } from './obstacles'
import { separationOffsets } from './steering'
import { system } from './system'

const MAX_CHUNKS = 120 // severed-limb chunk instances kept before the oldest are evicted
const _scratch = { x: 0, z: 0 } // obstacle push-out target

const STOP_DIST = 1.25 // keep out of the player's capsule
const TURN_RATE = 7 // 1/s yaw damp
const GLOW_FADE = 1.4 // seconds for the crystal glow to die with its owner
const SEP_RADIUS = 0.9 // crowd SPACING between bodies (not body size — that's EnemyDef.radius)…
const SEP_STRENGTH = 1.6 // …at up to this m/s — firmer than walk speed, so bodies never interpenetrate
const EMERGE_DEPTH = 0.6 // spawn: how far under the floor the body starts (lying pose is ~0.4 thick)
const EMERGE_TIME = 0.7 // s to breach the surface, then the getting-up clip plays
const LIGHT_HEIGHT = 0.85 // crystal light rides here above the body origin
const LIGHT_RANGE = 4 // m — a local pool of glow, not a room light

// what the aim/collision layers see: a stable handle + the live aim point. The point is
// owned by the enemy and rewritten each targets() call — read it within the frame, never retain it.
export interface EnemyTarget {
  id: number
  point: THREE.Vector3
}

// per-TYPE data derived from the first built instance of that species. Cached once per
// type so a second species can never overwrite the first's clip timing.
interface TypeRuntime {
  type: string
  def: EnemyDef
  deathDur: number
  walkDur: number // walk clip duration — feeds the loops-per-meter rate coupling
  walkClip: THREE.AnimationClip | null
  // the clip's AUTHORED forward-motion profile (extracted from the FBX hips at merge):
  // when present, ground motion follows the gait's non-uniform rate — zero foot slip,
  // authentic lurch. Absent (in-place clip) → constant speed + loops-per-meter fallback.
  walkProfile: RootMotionProfile | null
}

interface Enemy {
  id: number // stable handle, re-minted on every re-dress
  rt: TypeRuntime
  built: BuiltEntity
  preview: EntityPreview
  hp: number
  alive: boolean
  pooled: boolean // parked body, waiting to be re-dressed by the next wave
  spawnDelay: number // stagger: hidden until this runs out, THEN the emerge starts
  emergeLeft: number // rising through the floor (posed at the rise clip's first frame)
  riseLeft: number
  deathLeft: number
  heading: number
  lastHitAt: number // sim seconds of the last bolt — drives the stopping-power slow
  glowBase: Map<string, number> // authored emissive intensity per part (restored on respawn)
  light: THREE.PointLight | null // pooled crystal glow — rides the body, dies with the glow fade
  walkAction: THREE.AnimationAction | null // the walk action (for root-motion phase reads)
  riseAction: THREE.AnimationAction | null // the getting-up action (pinned to frame 0 while emerging)
  lastDist: number // cumulative profile distance at the last frame — step = delta
  target: EnemyTarget // persistent — targets() fills it in place, so the hot path never allocates
}

// linear-interpolated cumulative distance at clip time t
function distAt(p: RootMotionProfile, t: number): number {
  const times = p.times
  if (t <= times[0]) return p.dist[0]
  for (let i = 1; i < times.length; i++) {
    if (t <= times[i]) {
      const u = (t - times[i - 1]) / (times[i] - times[i - 1] || 1)
      return p.dist[i - 1] + (p.dist[i] - p.dist[i - 1]) * u
    }
  }
  return p.total
}

export class Horde {
  readonly list: Enemy[] = []
  private types = new Map<string, TypeRuntime>()
  private byId = new Map<number, Enemy>() // O(1) hit() resolution; only live bodies are present
  private nextId = 1
  private targetBuf: EnemyTarget[] = [] // reused every targets() call — never retained by callers

  private wave = 0 // stamped onto each baked corpse + reported on death facts

  constructor(
    private scene: THREE.Scene,
    private enemies: Record<string, EnemyDef>, // enemy type → archetype (doc + gameplay data)
    private effects: EffectSystem,
    // the horde REPORTS what happened (spawned/hit/died) and asks for nothing: blood,
    // sound, the ultimate's counter and the hit log are all subscribers (events.ts).
    private events: GameEvents,
    private lights: LightPool | null = null, // per-enemy crystal glow (one pooled PointLight each)
    // when a death animation finishes the corpse is BAKED into this batch (a cheap static
    // instance) and its skinned entity is freed to the pool — so hundreds of corpses cost a
    // handful of draw calls, not 4 each. Null = corpses just vanish (headless/test).
    private corpses: CorpseBatch | null = null,
    private obstacles: Box[] = [], // interior walls the horde must flow around, not through
  ) {
    // which wave a body belongs to is a fact the wave controller already reports — the
    // horde listens instead of being handed a closure back into the composition root
    events.on('waveStarted', ({ n }) => (this.wave = n))
  }

  // does this type exist? (WaveController validates its composition against this at boot)
  hasType(type: string): boolean {
    return type in this.enemies
  }

  private dropLight(z: Enemy): void {
    if (!z.light) return
    this.lights?.release(z.light)
    z.light = null
  }

  // lend one pooled light per enemy, tinted by its crystal emissive; null (pool dry) is fine
  private acquireLight(z: Enemy): void {
    if (z.light || !this.lights) return
    z.light = this.lights.lend(this.crystalColor(z), system.params.zombieLightIntensity, LIGHT_RANGE)
    this.updateLight(z)
  }

  // the crystal's own emissive colour (first exposed emissive part) → the light's colour
  private crystalColor(z: Enemy): number {
    for (const [, m] of z.built.emissiveParts ?? []) return m.emissive.getHex()
    return 0xffffff
  }

  // ride the body; intensity = registry × current glow ratio (dims with the death fade)
  private updateLight(z: Enemy): void {
    if (!z.light) return
    const p = z.built.group.position
    z.light.position.set(p.x, p.y + LIGHT_HEIGHT, p.z)
    z.light.intensity = system.params.zombieLightIntensity * this.glowRatio(z)
  }

  // crystal-light brightness relative to the authored glow: 1 while alive, follows the
  // emissive fade after death (light and crystal die together)
  private glowRatio(z: Enemy): number {
    if (z.alive) return 1
    for (const [part, m] of z.built.emissiveParts ?? []) {
      const base = z.glowBase.get(part) ?? 1
      return base > 0 ? m.emissiveIntensity / base : 0
    }
    return 0
  }

  // on the field = alive, not parked, past its spawn stagger, and out of the ground.
  // ONE definition — targets() and separate() both use it, so a new lifecycle stage
  // (stun, burrow) can't be remembered in one place and forgotten in the other.
  private onField(z: Enemy): boolean {
    return z.alive && !z.pooled && z.spawnDelay <= 0 && z.emergeLeft <= 0
  }

  // spawn (or recycle) one enemy of `type` at (x, z); it stays hidden for `delay`
  // seconds so simultaneous spawns don't play their rise animation in lockstep
  async spawnAt(type: string, x: number, z: number, delay: number): Promise<void> {
    const def = this.enemies[type]
    if (!def) throw new Error(`horde: unknown enemy type "${type}"`)
    // instance source: a free (parked) body of this type → build. Corpses don't live here —
    // once a death animation finishes the entity is baked into the CorpseBatch and parked, so
    // the pool refills fast and only the ~2s of dying enemies are ever expensive skinned meshes.
    let z0 = this.list.find((c) => c.pooled && c.rt.type === type)
    if (!z0) {
      const model = await loadGltfModel(def.doc.model!.src, def.doc.model!.anims ?? []) // raw parse cached; fresh skeleton clone
      const built = buildGlbEntity(def.doc, model)
      this.scene.add(built.group)
      let rt = this.types.get(type)
      if (!rt) {
        // first body of this species: cache its clip timing under ITS OWN key
        const death = built.clips?.find((c) => c.name === def.clips.death)
        const walk = built.clips?.find((c) => c.name === def.clips.walk)
        rt = {
          type,
          def,
          deathDur: death?.duration ?? 2,
          walkDur: walk?.duration ?? 1,
          walkClip: walk ?? null, // shared clip object across clones of this species
          walkProfile: (walk?.userData.rootMotion as RootMotionProfile | undefined) ?? null,
        }
        this.types.set(type, rt)
      }
      z0 = {
        id: 0,
        rt,
        built,
        preview: new EntityPreview(def.doc, built, this.depsFor(built)),
        hp: def.hp,
        alive: true,
        pooled: false,
        spawnDelay: 0,
        emergeLeft: 0,
        riseLeft: 0,
        deathLeft: Infinity,
        heading: 0,
        lastHitAt: -Infinity,
        glowBase: new Map([...(built.emissiveParts ?? new Map())].map(([part, m]) => [part, m.emissiveIntensity])),
        light: null,
        walkAction: null,
        riseAction: null,
        lastDist: 0,
        target: { id: 0, point: new THREE.Vector3() },
      }
      this.list.push(z0)
    }
    // (re)dress: NEW identity first — anything still holding the old handle now misses
    this.byId.delete(z0.id)
    z0.id = this.nextId++
    z0.target.id = z0.id
    this.byId.set(z0.id, z0)
    // …then position/heading, full hp, severed parts restored, glow restored
    this.dropLight(z0) // a body reclaimed mid-fade may still hold its light
    z0.pooled = false
    z0.alive = true
    z0.hp = z0.rt.def.hp
    z0.spawnDelay = delay
    z0.emergeLeft = 0
    z0.riseLeft = 0
    z0.deathLeft = Infinity
    z0.lastHitAt = -Infinity // a reused body starts un-slowed
    z0.built.group.position.set(x, 0, z)
    z0.heading = Math.atan2(-x, -z) // face the arena center
    z0.built.group.rotation.y = z0.heading
    z0.built.group.visible = false // hidden until the stagger delay elapses
    if (z0.built.mixer) z0.built.mixer.timeScale = 1 // rise/death play authored speed
    z0.preview.clearModifiers() // reversible dismemberment: severed parts re-show
    for (const [part, m] of z0.built.emissiveParts ?? []) m.emissiveIntensity = z0.glowBase.get(part) ?? m.emissiveIntensity
  }

  // the editor's dismember dep, verbatim semantics: bake+throw the part chunk to the
  // model's BACK (weight-scaled), hide the living mesh — the derived modifier keeps it
  // hidden across state changes. Chunks pool into one InstancedMesh per (model, part).
  private depsFor(built: BuiltEntity) {
    return {
      playSfx: () => {},
      playEffect: () => {},
      shatter: () => {},
      hideGeometry: () => {},
      onDespawn: () => {},
      dismember: (part: string, weight: number) => {
        const mesh = built.meshes.find((m) => m.userData.nodeName === part)
        if (!mesh) return
        const q = built.group.getWorldQuaternion(new THREE.Quaternion())
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
        dir.addScaledVector(right, (Math.random() - 0.5) * 0.5)
        this.effects.dismemberPart(mesh, dir, { weight, part })
        mesh.visible = false
      },
    }
  }

  update(dt: number, now: number, playerPos: THREE.Vector3): void {
    this.effects.capDismembered(MAX_CHUNKS) // budget the flying-limb chunk instances
    this.corpses?.update() // refresh the batched-corpse instance buffers if they changed
    for (const z of this.list) {
      if (z.pooled) continue
      if (!z.alive) {
        // ride the death clip to its last frame while the crystal glow dies with it…
        if (z.deathLeft > 0) {
          const step = Math.min(dt, z.deathLeft)
          z.preview.update(step)
          z.deathLeft -= step
          for (const [, m] of z.built.emissiveParts ?? []) {
            if (m.emissiveIntensity > 0) m.emissiveIntensity = Math.max(0, m.emissiveIntensity - (dt / GLOW_FADE) * (z.glowBase.get('crystals') ?? 1))
          }
          this.updateLight(z) // the crystal light dims with the glow
          if (z.deathLeft <= 0) {
            // …then the death pose is BAKED into the batched-corpse mesh (cheap static
            // instance) and the expensive skinned entity is freed straight back to the pool.
            this.dropLight(z)
            this.corpses?.add(z.built, z.rt.type, this.wave)
            this.byId.delete(z.id) // the handle dies with the body
            z.pooled = true
            z.built.group.visible = false
          }
        }
        continue
      }
      // stagger: hold hidden, then start the EMERGE — begin under the floor, posed at the
      // getting-up clip's first (lying) frame; the raise happens before it stands up
      if (z.spawnDelay > 0) {
        z.spawnDelay -= dt
        if (z.spawnDelay <= 0) {
          z.built.group.visible = true
          z.built.group.position.y = -EMERGE_DEPTH
          z.preview.setState(z.rt.def.clips.rise, 0) // getting-up clip, snapped to frame 0
          const rise = z.built.clips?.find((c) => c.name === z.rt.def.clips.rise)
          z.riseAction = rise && z.built.mixer ? z.built.mixer.clipAction(rise) : null
          z.emergeLeft = EMERGE_TIME
          this.acquireLight(z) // crystal glow lights the floor it claws out of
          this.events.emit('enemySpawned', { kind: z.rt.def.kind, at: z.built.group.position })
        }
        continue
      }
      // breaching: raise the body up through the floor while PINNING the rise clip at its
      // first frame (time = 0 each tick) — it can't start standing until it's clear
      if (z.emergeLeft > 0) {
        z.emergeLeft -= dt
        const k = THREE.MathUtils.clamp(1 - z.emergeLeft / EMERGE_TIME, 0, 1)
        z.built.group.position.y = -EMERGE_DEPTH * (1 - k)
        if (z.riseAction) z.riseAction.time = 0
        z.preview.update(dt) // advances the crossfade (settles onto the rise pose), clip held at ~frame 0
        this.updateLight(z)
        if (z.emergeLeft <= 0) {
          z.built.group.position.y = 0
          z.riseLeft = z.riseAction ? z.riseAction.getClip().duration * 0.95 : 0 // NOW the getting-up plays for real
        }
        continue
      }
      z.preview.update(dt)
      if (z.riseLeft > 0) {
        z.riseLeft -= dt
        if (z.riseLeft <= 0) {
          z.preview.setState(z.rt.def.clips.walk)
          // grab the walk action for root-motion phase reads
          z.walkAction = z.rt.walkClip && z.built.mixer ? z.built.mixer.existingAction(z.rt.walkClip) : null
          z.lastDist = 0
        }
        this.updateLight(z)
        continue
      }
      // chase: face + close on the player, stop at melee distance.
      let speed = system.params.zombieSpeed
      // stopping power: an enemy hit within the last window crawls (registry factor). The
      // animation timeScale below is derived from `speed`, so it staggers with feet gripping.
      if (now - z.lastHitAt < system.params.stoppingPowerTime) speed *= system.params.stoppingPower
      let step: number
      if (z.rt.walkProfile && z.walkAction) {
        // ROOT-MOTION mode: timeScale makes one loop cover profile.total at the registry
        // AVERAGE speed; the per-frame step follows the authored non-uniform gait — the
        // body surges in the stride and settles in the stance, feet never slip.
        if (z.built.mixer) z.built.mixer.timeScale = (speed * z.rt.walkDur) / z.rt.walkProfile.total
        const t = z.walkAction.time % z.rt.walkDur
        const dNow = distAt(z.rt.walkProfile, t)
        step = dNow - z.lastDist
        if (step < 0) step += z.rt.walkProfile.total // loop wrap
        z.lastDist = dNow
      } else {
        // fallback (in-place clip): constant speed + loops-per-meter rate coupling
        if (z.built.mixer) z.built.mixer.timeScale = speed * system.params.zombieWalkLpm * z.rt.walkDur
        step = speed * dt
      }
      const zx = z.built.group.position.x
      const zz = z.built.group.position.z
      // navigate around interior walls: steer toward a corner when the direct path to the
      // player is blocked, so the horde flows AROUND cover instead of pressing into it
      const goal: { x: number; z: number } = this.obstacles.length ? navigateAround(zx, zz, playerPos.x, playerPos.z, z.rt.def.radius, this.obstacles) : playerPos
      const gx = goal.x - zx
      const gz = goal.z - zz
      const gdist = Math.hypot(gx, gz)
      const pdist = Math.hypot(playerPos.x - zx, playerPos.z - zz)
      if (pdist < 1e-3 || gdist < 1e-3) continue
      const yaw = Math.atan2(gx, gz) // face + move toward the goal (corner or player)
      let d = yaw - z.heading
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      z.heading += d * (1 - Math.exp(-TURN_RATE * dt))
      z.built.group.rotation.y = z.heading
      if (pdist > STOP_DIST) {
        // move toward the goal, but stop at melee based on the REAL player distance
        z.built.group.position.x += (gx / gdist) * step
        z.built.group.position.z += (gz / gdist) * step
      }
      this.updateLight(z) // crystal light follows the body
    }
    this.separate(dt)
  }

  // after everyone has chased: nudge crowding bodies apart (separation steering) and push
  // any that entered an interior wall back out (they slide along it toward the player).
  // One position snapshot of the on-ground horde; the steering is reusable by any manager.
  private separate(dt: number): void {
    const agents = this.list.filter((z) => this.onField(z))
    if (!agents.length) return
    const offs = agents.length >= 2 ? separationOffsets(agents.map((z) => z.built.group.position), SEP_RADIUS) : null
    if (!offs && !this.obstacles.length) return
    for (let i = 0; i < agents.length; i++) {
      const p = agents[i].built.group.position
      if (offs) {
        p.x += offs[i].x * SEP_STRENGTH * dt
        p.z += offs[i].z * SEP_STRENGTH * dt
      }
      if (this.obstacles.length) {
        pushCircleOut(p.x, p.z, agents[i].rt.def.radius, this.obstacles, _scratch) // out of interior walls
        p.x = _scratch.x
        p.z = _scratch.z
      }
      this.updateLight(agents[i]) // keep the crystal light on the moved body
    }
  }

  // aim/hit candidates: every on-field enemy, as {id, live aim point}. The returned array
  // and its points are REUSED next call — consume them within the frame, never retain.
  targets(): readonly EnemyTarget[] {
    this.targetBuf.length = 0
    for (const z of this.list) {
      if (!this.onField(z)) continue
      const p = z.built.group.position
      z.target.point.set(p.x, z.rt.def.aimHeight, p.z)
      this.targetBuf.push(z.target)
    }
    return this.targetBuf
  }

  aliveCount(): number {
    return this.list.reduce((n, z) => n + (z.alive && !z.pooled ? 1 : 0), 0)
  }

  // apply one bolt hit: damage from the registry, dismemberment roll while parts remain,
  // death when hp runs out. Reports enemyHit (always) and enemyDied (when it was the last
  // one) — what those facts trigger is entirely up to their subscribers.
  // `at`/`dir` describe the impact: where the bolt landed and which way it was travelling.
  hit(id: number, at: THREE.Vector3, dir: THREE.Vector3, now: number): void {
    const z = this.byId.get(id)
    if (!z || !z.alive || z.pooled) return // stale id (already dead / recycled) — nothing to hit
    z.lastHitAt = now // stopping power: slow it for the next window
    z.hp -= system.params.damage
    let severed: string | null = null
    if (Math.random() < system.params.dismemberChance) {
      const parts = Object.keys(z.rt.def.doc.model?.dismember ?? {}).filter((p) => !z.preview.activeModifiers.has(`dismembered_${p}`))
      if (parts.length) {
        severed = parts[(Math.random() * parts.length) | 0]
        z.preview.fireEvent(`dismember_${severed}`) // the shared derived-event path
      }
    }
    const kind = z.rt.def.kind
    this.events.emit('enemyHit', { kind, at, dir, hp: z.hp, severed })
    if (z.hp <= 0) {
      this.die(z)
      // the death fact reports where the BODY is (the pool of blood belongs under the
      // corpse), not where the bolt struck it
      this.events.emit('enemyDied', { kind, at: z.built.group.position, wave: this.wave })
    }
  }

  private die(z: Enemy): void {
    z.alive = false
    if (z.built.mixer) z.built.mixer.timeScale = 1 // death plays at authored speed
    z.preview.setState(z.rt.def.clips.death)
    z.deathLeft = z.rt.deathDur * 0.96
    // the corpse is handed to the CorpseBatch when the death animation finishes (update())
  }

  // corpses on the battlefield (all batched — a handful of draw calls regardless of count)
  corpseCount(): number {
    return this.corpses?.count() ?? 0
  }

  // dev control: drop everything standing (tests wave transitions/corpses instantly)
  killAll(): void {
    for (const z of this.list) if (z.alive && !z.pooled) this.die(z)
  }
}
