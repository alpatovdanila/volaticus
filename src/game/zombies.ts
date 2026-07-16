// Zombie horde — enemy instances + the instance POOL the wave controller draws from.
// A dead zombie isn't destroyed: reclaim() parks it, and the next spawnAt() re-dresses
// it (reset hp/state/position, restore severed parts via the reversible dismemberment
// modifiers, restore the crystal glow) — building a fresh skeleton clone only happens
// when the pool runs dry. That keeps wave N+1 free of build hitches and is the seam
// where true instanced hordes (baked-bone-texture, ~100 enemies) plug in later.
//
// Presentation runs through the SAME EntityPreview + derived-dismemberment machinery
// as the editor: a landed hit rolls system.params.dismemberChance and fires the derived
// `dismember_<part>` event → severed chunk into the shared instanced pools + reversible
// `dismembered_<part>` modifier. Identical code path, shared chunk draw calls.
import * as THREE from 'three'
import { EntityPreview } from '../inventory/preview'
import { buildGlbEntity, type BuiltEntity } from '../inventory/factory'
import { loadGltfModel, type RootMotionProfile } from '../inventory/gltf'
import type { EntityDoc } from '../inventory/schema'
import type { EffectSystem } from '../inventory/effects'
import type { CorpseBatch } from './corpses'
import { LightPool } from './lights'
import { pushCircleOut, navigateAround, type Box } from './obstacles'
import { separationOffsets } from './steering'
import { system } from './system'

const MAX_CHUNKS = 120 // severed-limb chunk instances kept before the oldest are evicted
const ZOMBIE_R = 0.35 // body radius used for interior-wall push-out
const _scratch = { x: 0, z: 0 } // obstacle push-out target

const STOP_DIST = 1.25 // keep out of the player's capsule
const TURN_RATE = 7 // 1/s yaw damp
const HP = 5
const AIM_HEIGHT = 0.7 // alyosha is squat — bolts aim/hit at his chest
const GLOW_FADE = 1.4 // seconds for the crystal glow to die with its owner
const SEP_RADIUS = 0.9 // enemies closer than this (center-to-center) push apart…
const SEP_STRENGTH = 1.6 // …at up to this m/s — firmer than walk speed, so bodies never interpenetrate
const EMERGE_DEPTH = 0.6 // spawn: how far under the floor the body starts (lying pose is ~0.4 thick)
const EMERGE_TIME = 0.7 // s to breach the surface, then the getting-up clip plays
const LIGHT_HEIGHT = 0.85 // crystal light rides here above the body origin
const LIGHT_RANGE = 4 // m — a local pool of glow, not a room light

export interface HitResult {
  hp: number
  died: boolean
  severed: string | null
}

interface Zombie {
  type: string
  built: BuiltEntity
  preview: EntityPreview
  hp: number
  alive: boolean
  pooled: boolean // parked corpse, waiting to be re-dressed by the next wave
  spawnDelay: number // stagger: hidden until this runs out, THEN the emerge starts
  emergeLeft: number // rising through the floor (posed at the rise clip's first frame)
  riseLeft: number
  deathLeft: number
  heading: number
  lastHitAt: number // performance.now()/1000 of the last bolt — drives the stopping-power slow
  glowBase: Map<string, number> // authored emissive intensity per part (restored on respawn)
  light: THREE.PointLight | null // pooled crystal glow — rides the body, dies with the glow fade
  walkAction: THREE.AnimationAction | null // the Walking action (for root-motion phase reads)
  riseAction: THREE.AnimationAction | null // the getting-up action (pinned to frame 0 while emerging)
  lastDist: number // cumulative profile distance at the last frame — step = delta
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
  readonly list: Zombie[] = []
  private deathDur = 2
  private walkDur = 1 // Walking clip duration — feeds the loops-per-meter rate coupling
  private walkClip: THREE.AnimationClip | null = null
  // the clip's AUTHORED forward-motion profile (extracted from the FBX hips at merge):
  // when present, ground motion follows the gait's non-uniform rate — zero foot slip,
  // authentic lurch. Absent (in-place clip) → constant speed + loops-per-meter fallback.
  private walkProfile: RootMotionProfile | null = null

  constructor(
    private scene: THREE.Scene,
    private docs: Record<string, EntityDoc>, // enemy type → entity doc
    private effects: EffectSystem,
    private sfx: ((id: string, at?: THREE.Vector3) => void) | null = null, // semantic sound hook (inventory ids, optional world position)
    private lights: LightPool | null = null, // per-zombie crystal glow (one pooled PointLight each)
    // when a death animation finishes the corpse is BAKED into this batch (a cheap static
    // instance) and its skinned entity is freed to the pool — so hundreds of corpses cost a
    // handful of draw calls, not 4 each. Null = corpses just vanish (headless/test).
    private corpses: CorpseBatch | null = null,
    private generation: () => number = () => 0, // current wave — stamped onto each baked corpse
    private obstacles: Box[] = [], // interior walls the horde must flow around, not through
  ) {}

  private dropLight(z: Zombie): void {
    if (!z.light) return
    this.lights?.release(z.light)
    z.light = null
  }

  // lend one pooled light per zombie, tinted by its crystal emissive; null (pool dry) is fine
  private acquireLight(z: Zombie): void {
    if (z.light || !this.lights) return
    z.light = this.lights.lend(this.crystalColor(z), system.params.zombieLightIntensity, LIGHT_RANGE)
    this.updateLight(z)
  }

  // the crystal's own emissive colour (first exposed emissive part) → the light's colour
  private crystalColor(z: Zombie): number {
    for (const [, m] of z.built.emissiveParts ?? []) return m.emissive.getHex()
    return 0xffffff
  }

  // ride the body; intensity = registry × current glow ratio (dims with the death fade)
  private updateLight(z: Zombie): void {
    if (!z.light) return
    const p = z.built.group.position
    z.light.position.set(p.x, p.y + LIGHT_HEIGHT, p.z)
    z.light.intensity = system.params.zombieLightIntensity * this.glowRatio(z)
  }

  // crystal-light brightness relative to the authored glow: 1 while alive, follows the
  // emissive fade after death (light and crystal die together)
  private glowRatio(z: Zombie): number {
    if (z.alive) return 1
    for (const [part, m] of z.built.emissiveParts ?? []) {
      const base = z.glowBase.get(part) ?? 1
      return base > 0 ? m.emissiveIntensity / base : 0
    }
    return 0
  }

  // spawn (or recycle) one enemy of `type` at (x, z); it stays hidden for `delay`
  // seconds so simultaneous spawns don't play their rise animation in lockstep
  async spawnAt(type: string, x: number, z: number, delay: number): Promise<void> {
    const doc = this.docs[type]
    if (!doc) throw new Error(`horde: unknown enemy type "${type}"`)
    // instance source: a free (pooled) entity → build. Corpses no longer live here — once
    // a death animation finishes the entity is baked into the CorpseBatch and pooled, so the
    // pool refills fast and only the ~2s of dying zombies are ever expensive skinned meshes.
    let z0 = this.list.find((c) => c.pooled && c.type === type)
    if (!z0) {
      const model = await loadGltfModel(doc.model!.src, doc.model!.anims ?? []) // raw parse cached; fresh skeleton clone
      const built = buildGlbEntity(doc, model)
      this.scene.add(built.group)
      const death = built.clips?.find((c) => c.name === 'Zombie Death')
      if (death) this.deathDur = death.duration
      const walk = built.clips?.find((c) => c.name === 'Walking')
      if (walk) {
        this.walkDur = walk.duration
        this.walkClip = walk // shared clip object across clones
        this.walkProfile = (walk.userData.rootMotion as RootMotionProfile | undefined) ?? null
      }
      z0 = {
        type,
        built,
        preview: new EntityPreview(doc, built, this.depsFor(built)),
        hp: HP,
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
      }
      this.list.push(z0)
    }
    // (re)dress: position/heading, full hp, severed parts restored, glow restored
    this.dropLight(z0) // a corpse reclaimed mid-fade may still hold its light
    z0.pooled = false
    z0.alive = true
    z0.hp = HP
    z0.spawnDelay = delay
    z0.emergeLeft = 0
    z0.riseLeft = 0
    z0.deathLeft = Infinity
    z0.lastHitAt = -Infinity // a reused corpse starts un-slowed
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

  update(dt: number, playerPos: THREE.Vector3): void {
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
            this.corpses?.add(z.built, this.generation())
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
          z.preview.setState('index', 0) // getting-up clip, snapped to frame 0
          const rise = z.built.clips?.find((c) => c.name === 'index')
          z.riseAction = rise && z.built.mixer ? z.built.mixer.clipAction(rise) : null
          z.emergeLeft = EMERGE_TIME
          this.acquireLight(z) // crystal glow lights the floor it claws out of
          this.sfx?.('zombie_rise', z.built.group.position)
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
          const rise = z.built.clips?.find((c) => c.name === 'index')
          z.riseLeft = rise ? rise.duration * 0.95 : 0 // NOW the getting-up plays for real
        }
        continue
      }
      z.preview.update(dt)
      if (z.riseLeft > 0) {
        z.riseLeft -= dt
        if (z.riseLeft <= 0) {
          z.preview.setState('Walking')
          // grab the Walking action for root-motion phase reads
          z.walkAction = this.walkClip && z.built.mixer ? z.built.mixer.existingAction(this.walkClip) : null
          z.lastDist = 0
        }
        this.updateLight(z)
        continue
      }
      // chase: face + close on the player, stop at melee distance.
      let speed = system.params.zombieSpeed
      // stopping power: a zombie hit within the last window crawls (registry factor). The
      // animation timeScale below is derived from `speed`, so it staggers with feet gripping.
      if (performance.now() / 1000 - z.lastHitAt < system.params.stoppingPowerTime) speed *= system.params.stoppingPower
      let step: number
      if (this.walkProfile && z.walkAction) {
        // ROOT-MOTION mode: timeScale makes one loop cover profile.total at the registry
        // AVERAGE speed; the per-frame step follows the authored non-uniform gait — the
        // body surges in the stride and settles in the stance, feet never slip.
        if (z.built.mixer) z.built.mixer.timeScale = (speed * this.walkDur) / this.walkProfile.total
        const t = z.walkAction.time % this.walkDur
        const dNow = distAt(this.walkProfile, t)
        step = dNow - z.lastDist
        if (step < 0) step += this.walkProfile.total // loop wrap
        z.lastDist = dNow
      } else {
        // fallback (in-place clip): constant speed + loops-per-meter rate coupling
        if (z.built.mixer) z.built.mixer.timeScale = speed * system.params.zombieWalkLpm * this.walkDur
        step = speed * dt
      }
      const zx = z.built.group.position.x
      const zz = z.built.group.position.z
      // navigate around interior walls: steer toward a corner when the direct path to the
      // player is blocked, so the horde flows AROUND cover instead of pressing into it
      const goal: { x: number; z: number } = this.obstacles.length ? navigateAround(zx, zz, playerPos.x, playerPos.z, ZOMBIE_R, this.obstacles) : playerPos
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
    const agents = this.list.filter((z) => z.alive && !z.pooled && z.spawnDelay <= 0 && z.emergeLeft <= 0)
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
        pushCircleOut(p.x, p.z, ZOMBIE_R, this.obstacles, _scratch) // out of interior walls
        p.x = _scratch.x
        p.z = _scratch.z
      }
      this.updateLight(agents[i]) // keep the crystal light on the moved body
    }
  }

  // aim/hit candidates: alive AND actually on the field — not staggered-hidden, and not
  // still underground mid-emerge (can't shoot what hasn't breached the floor yet)
  targets(): { object: THREE.Object3D; point: THREE.Vector3 }[] {
    return this.list
      .filter((z) => z.alive && !z.pooled && z.spawnDelay <= 0 && z.emergeLeft <= 0)
      .map((z) => ({ object: z.built.group, point: z.built.group.position.clone().setY(AIM_HEIGHT) }))
  }

  aliveCount(): number {
    return this.list.reduce((n, z) => n + (z.alive && !z.pooled ? 1 : 0), 0)
  }

  // apply one bolt hit: damage from the registry, dismemberment roll while parts remain,
  // death when hp runs out. Returns what happened (for effects/HUD/log).
  hit(group: THREE.Object3D): HitResult | null {
    const z = this.list.find((x) => x.built.group === group)
    if (!z || !z.alive || z.pooled) return null
    z.lastHitAt = performance.now() / 1000 // stopping power: slow it for the next window
    z.hp -= system.params.damage
    let severed: string | null = null
    if (Math.random() < system.params.dismemberChance) {
      const parts = Object.keys(this.docs[z.type].model?.dismember ?? {}).filter((p) => !z.preview.activeModifiers.has(`dismembered_${p}`))
      if (parts.length) {
        severed = parts[(Math.random() * parts.length) | 0]
        z.preview.fireEvent(`dismember_${severed}`) // the shared derived-event path
      }
    }
    const died = z.hp <= 0
    if (died) this.die(z)
    return { hp: z.hp, died, severed }
  }

  private die(z: Zombie): void {
    z.alive = false
    if (z.built.mixer) z.built.mixer.timeScale = 1 // death plays at authored speed
    z.preview.setState('Zombie Death')
    z.deathLeft = this.deathDur * 0.96
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
