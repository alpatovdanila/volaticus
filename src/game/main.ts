// DEATHTERRA testing grounds — the first dev-only level (see docs/GAME.md).
// A walled PBR arena, the marine2 player with analog gamepad locomotion (walk band →
// run band on one stick curve), auto-aim/auto-fire while stationary, and a zombie
// horde that rises and closes in — with registry-driven dismemberment through the
// same EntityPreview/EffectSystem path the editor uses.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { scopeHmrReloads } from '../lib/hmr-scope'
import { LightingRig, LIGHT_DEFAULTS, clampLightParams } from '../lib/lighting'
import { loadGltfModel } from '../inventory/gltf'
import { buildGlbEntity, type BuiltEntity } from '../inventory/factory'
import { validateEntity, type EntityDoc, type MaterialCatalogDoc } from '../inventory/schema'
import { EffectSystem } from '../inventory/effects'
import { configureKtx2, setMaterialCatalog, makeSlotMaterial, whenTexturesReady, setAnisotropy } from '../inventory/materials'
import { pollMove, pollActionPress } from './input'
import { UltimateController, ZombieEaterUltimate } from './ultimate'
import { Targeting } from './targeting'
import { PlayerController } from './player'
import { Projectiles, BOLT_COLOR } from './projectiles'
import { LightPool } from './lights'
import { Orbs } from './orbs'
import { Horde } from './zombies'
import { WaveController } from './waves'
import { EffectsManager } from './effectsManager'
import { BloodSplatters } from './blood'
import { CorpseBatch } from './corpses'
import { Casings } from './casings'
import { boxFrom, segmentEntryT, type Box } from './obstacles'
import { system } from './system'
import { mountTuningPanel } from './tuning'
import { mountSettingsPanel } from './settings'
import { TEST_LEVEL } from './level'
import { loadGraphics, aaRenderScale, aaMsaa } from './userPrefs'
import { PostChain } from './post'
import { initAudio, sfx, sfxAt, setListener, startAmbience } from './audio'
import marineRaw from '../../inventory/entities/marine2/marine2.json'
import alyoshaRaw from '../../inventory/entities/alyosha/alyosha.json'

// the dev server suppresses full reloads for src/** unless the page opts in
scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/'])

const level = TEST_LEVEL
const ARENA_HALF = level.arenaHalf
const PLAYER_RADIUS = 0.45
const FIRE_RANGE = 14
const UV_PER_METER = 0.25 // 4m per texture tile

// GRAPHICS = user registry (persisted per machine); LIGHTING = level data
const gfx = loadGraphics()
const levelLights = clampLightParams({ ...LIGHT_DEFAULTS, ...level.lights })

// --- boot ------------------------------------------------------------------

// trackTimestamp = GPU timer-query pool for the perf HUD (real GPU frametimes)
const renderer = new WebGPURenderer({ antialias: aaMsaa(gfx.aa), trackTimestamp: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * aaRenderScale(gfx.aa))
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200)
const rig = new LightingRig(renderer, scene)
const post = new PostChain(renderer, scene, camera)

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}
window.addEventListener('resize', resize)
resize()

function applyGraphics(): void {
  post.setGtao(gfx.gtao)
  post.setGtaoResolution(gfx.gtaoRes)
  post.setTiltShift(gfx.tilt)
  post.setTiltShiftStrength(gfx.tiltStrength)
  post.setGtaoStrength(levelLights.ao) // AO depth is a lighting call (rides the level's lights)
}

// --- arena (PBR from the material catalog) ----------------------------------

// planar-map UVs from vertex positions so catalog textures tile in METERS across
// the arena (geometry is built in world coordinates; meshes sit at the origin)
function planarUv(geo: THREE.BufferGeometry, axes: 'xz' | 'xy' | 'zy'): void {
  const pos = geo.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const [u, v] = axes === 'xz' ? [x, z] : axes === 'xy' ? [x, y] : [z, y]
    uv[i * 2] = u * UV_PER_METER
    uv[i * 2 + 1] = v * UV_PER_METER
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

// cubic (per-face) projection: each vertex's UVs come from the world-space plane its face
// points at, chosen by the dominant normal axis — so every face of a box tiles the texture
// at true scale with no stretching (a single planar projection smears the side/top faces).
function cubicUv(geo: THREE.BufferGeometry, scale: number): void {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i))
    const ny = Math.abs(nor.getY(i))
    const nz = Math.abs(nor.getZ(i))
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    let u: number
    let v: number
    if (nx >= ny && nx >= nz) {
      u = z // ±X faces → ZY plane
      v = y
    } else if (ny >= nx && ny >= nz) {
      u = x // ±Y faces → XZ plane
      v = z
    } else {
      u = x // ±Z faces → XY plane
      v = y
    }
    uv[i * 2] = u * scale
    uv[i * 2 + 1] = v * scale
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

async function loadMaterialCatalog(): Promise<void> {
  const res = await fetch('/__materials')
  const json = (await res.json()) as { materials: { doc: MaterialCatalogDoc & { id: string } }[] }
  setMaterialCatalog(Object.fromEntries(json.materials.map((m) => [m.doc.id, m.doc])))
}

// builds the floor + perimeter walls + interior cover walls; returns the interior walls'
// XZ footprints for collision (the perimeter is handled by the ±arenaHalf position clamps)
function buildArena(): Box[] {
  const size = ARENA_HALF * 2 + 2
  const floorGeo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2)
  planarUv(floorGeo, 'xz')
  const floor = new THREE.Mesh(floorGeo, makeSlotMaterial('game-floor', { material: level.floorMat }))
  floor.receiveShadow = true
  scene.add(floor)

  const wallMat = makeSlotMaterial('game-wall', { material: level.wallMat })
  const t = 0.6
  const len = size + t * 2
  const wallH = 2.8
  for (const [x, z, horizontal] of [
    [0, size / 2 + t / 2, true],
    [0, -(size / 2 + t / 2), true],
    [size / 2 + t / 2, 0, false],
    [-(size / 2 + t / 2), 0, false],
  ] as [number, number, boolean][]) {
    const geo = new THREE.BoxGeometry(horizontal ? len : t, wallH, horizontal ? t : len)
    geo.translate(x, wallH / 2, z) // world-space verts → UVs tile continuously along the wall
    cubicUv(geo, UV_PER_METER) // per-face projection: brick tiles cleanly on faces AND ends
    const wall = new THREE.Mesh(geo, wallMat)
    wall.castShadow = true
    wall.receiveShadow = true
    scene.add(wall)
  }

  // interior cover walls (level data) — same material, a bit shorter so the top-down camera
  // still reads over them; each contributes an XZ footprint to the obstacle set
  const obstacles: Box[] = []
  const innerH = 2
  for (const w of level.interiorWalls ?? []) {
    const geo = new THREE.BoxGeometry(w.w, innerH, w.d)
    geo.translate(w.x, innerH / 2, w.z)
    cubicUv(geo, UV_PER_METER)
    const mesh = new THREE.Mesh(geo, wallMat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    scene.add(mesh)
    obstacles.push(boxFrom(w.x, w.z, w.w, w.d))
  }
  return obstacles
}

// --- entities --------------------------------------------------------------

function docOf(raw: unknown, name: string): EntityDoc {
  const { doc, issues } = validateEntity(raw)
  if (!doc) throw new Error(`${name}: invalid entity doc: ${issues.join('; ')}`)
  return doc
}

async function buildEntity(doc: EntityDoc, at: THREE.Vector3, yaw: number): Promise<BuiltEntity> {
  const model = await loadGltfModel(doc.model!.src, doc.model!.anims ?? [])
  const built = buildGlbEntity(doc, model)
  built.group.position.copy(at)
  built.group.rotation.y = yaw
  scene.add(built.group)
  return built
}

// --- game ------------------------------------------------------------------

const hud = document.getElementById('hud')!

async function start(): Promise<void> {
  await renderer.init()
  configureKtx2(renderer) // catalog textures are .ktx2 — must run before any material builds
  setAnisotropy(gfx.aniso) // user graphics — creation-time (before materials build)
  rig.setHiddenBackground('#000000') // game: hidden sky = black void, not the editor's studio grey
  rig.applyParams(levelLights) // LIGHTING COMES FROM THE LEVEL (level.ts), not user prefs
  applyGraphics()
  // dlight pool BEFORE anything renders: the very first pipeline compile already
  // includes the full light set, so the count never changes → no recompiles, ever
  const lightPool = new LightPool(scene) // bolt tracers (6)
  const zombieLights = new LightPool(scene, 12) // one crystal glow per zombie (pool caps the count)
  // static fill orbs — created BEFORE the first render so the light count is fixed. Their
  // colour is the BULLET tracer colour (single source of truth: change the tracer, the orbs
  // follow); orbConfig is the single mutable copy the slider edits and the orbs read.
  const orbConfig = level.orbs ? { ...level.orbs, color: BOLT_COLOR } : null
  const orbs = orbConfig ? new Orbs(scene, orbConfig) : null
  await loadMaterialCatalog()
  const obstacles = buildArena() // interior-wall footprints for player/horde/bolt collision

  const marineDoc = docOf(marineRaw, 'marine2')
  const alyoshaDoc = docOf(alyoshaRaw, 'alyosha')

  // player controller: owns the stance machine (moving → settling → standing), analog
  // locomotion, movement integration and the hand-bone muzzle. Input stays external.
  const playerBuilt = await buildEntity(marineDoc, new THREE.Vector3(0, 0, 0), 0)
  const player = new PlayerController(playerBuilt, ARENA_HALF, PLAYER_RADIUS, obstacles)

  // shared effect system + the game-facing manager (semantic calls, budgets, throttling)
  const effects = new EffectSystem(scene)
  const fxm = new EffectsManager(effects)
  const blood = new BloodSplatters(scene) // reflective floor decals (hits + death pools)
  const casings = new Casings(scene) // ejected shell casings (hot → cool, batched on the floor)

  // sounds are inventory-driven: these ids resolve to inventory/sfx docs → files
  initAudio()
  if (level.ambience) startAmbience(level.ambience)

  // dead zombies bake into this batch (few draw calls for the whole battlefield); the wave
  // counter is stamped on each corpse (survival policy + HUD)
  const corpseBatch = new CorpseBatch(scene)
  let currentWave = 0
  const horde = new Horde(scene, { alyosha: alyoshaDoc }, effects, (id, at) => (at ? sfxAt(id, at.x, at.y, at.z) : sfx(id)), zombieLights, corpseBatch, () => currentWave, obstacles)
  const waves = new WaveController(horde, level.wave)
  waves.onWaveStart = (w) => (currentWave = w)

  rig.fitShadow(new THREE.Box3(new THREE.Vector3(-ARENA_HALF - 2, 0, -ARENA_HALF - 2), new THREE.Vector3(ARENA_HALF + 2, 3, ARENA_HALF + 2)))
  rig.patchShadow(scene)
  // Shadow policy: DYNAMIC on the direct path (request once, never settle → the map
  // re-renders every frame, moving characters can't leave stuck shadows). Under the
  // post chain shadows must stay CACHED (see the r185 note in the frame loop) — the
  // map renders through this direct flush, outside any MRT pass, whenever it's dirty.
  const flushShadowDirect = (): void => {
    rig.requestShadowUpdate()
    renderer.render(scene, camera)
    rig.settleShadow()
  }
  rig.requestShadowUpdate()

  await whenTexturesReady() // no black-texture first frame
  if (post.active()) flushShadowDirect() // bake the initial shadow before the first pass render

  // all DEV overlays live in one container (the debug HUD, perf readout, settings + tuning
  // panels) so entering fullscreen can hide the lot with a single toggle — a clean play/
  // capture view. The ultimate HUD stays out of it: that's gameplay UI, not dev chrome.
  const overlays = document.createElement('div')
  overlays.id = 'overlays'
  document.body.appendChild(overlays)
  overlays.appendChild(hud) // reparent the debug HUD from <body> into the container
  document.addEventListener('fullscreenchange', () => {
    overlays.style.display = document.fullscreenElement ? 'none' : ''
  })
  // 'F' toggles fullscreen (keydown is a user gesture, so requestFullscreen is allowed)
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF') return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  })

  // settings panels: lighting edits the LEVEL's data live, graphics edits the user registry
  mountSettingsPanel(
    {
    lights: levelLights,
    graphics: gfx,
    orbs: orbConfig ?? undefined,
    onLights: () => {
      rig.applyParams(levelLights) // arms a shadow update…
      if (post.active()) flushShadowDirect() // …which must render OUTSIDE the pass
      post.setGtaoStrength(levelLights.ao)
    },
    onGraphics: applyGraphics,
    onOrbs: () => orbs?.setIntensity(orbConfig!.intensity),
    },
    overlays,
  )

  // dev mode: pacifist = no aiming/shooting at all + player invincible (tweak
  // animations in peace); the flag lives here (composition root), immunity on the player
  let pacifist = false

  // animation↔ground coupling sliders (tune, then graduate values into DEFAULT_PARAMS)
  mountTuningPanel(
    [
      { key: 'playerWalkLpm', label: 'player walk l/m', min: 0.05, max: 2, step: 0.01 },
      { key: 'playerRunLpm', label: 'player run l/m', min: 0.05, max: 2, step: 0.01 },
      { key: 'zombieWalkLpm', label: 'zombie walk l/m', min: 0.05, max: 2, step: 0.01 },
      { key: 'zombieLightIntensity', label: 'zombie light', min: 0, max: 8, step: 0.1 },
      { key: 'targetStickiness', label: 'target stick', min: 0, max: 1, step: 0.05 },
    ],
    [
      {
        label: 'pacifist',
        isOn: () => pacifist,
        onClick: () => {
          pacifist = !pacifist
          player.invincible = pacifist
        },
      },
      { label: 'clear wave', onClick: () => horde.killAll() },
    ],
    overlays,
  )

  const projectiles = new Projectiles(scene, ARENA_HALF + 0.75, lightPool, obstacles) // wall sparks + dlight per bolt
  // ultimate: kills charge the bar; the action button spends it on ZOMBIE EATER (shotgun)
  const ultimate = new UltimateController(new ZombieEaterUltimate())
  // sticky auto-targeting: locks a target and holds it (see targeting.ts) to stop the
  // re-acquire thrash when a horde closes in — the game still decides what's a valid target
  const targeting = new Targeting()
  const hitLog: string[] = []
  ;(window as unknown as { __game: unknown }).__game = { player, horde, waves, effects, blood, casings, ultimate, targeting, scene, camera, renderer, rig, post, hitLog }

  // ultimate HUD — a single line centered at the bottom of the screen
  const ultHud = document.createElement('div')
  ultHud.id = 'ult'
  ultHud.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);font:600 15px/1.4 monospace;letter-spacing:1px;pointer-events:none;text-shadow:0 1px 3px #000;'
  document.body.appendChild(ultHud)
  const updateUltHud = (): void => {
    if (ultimate.isActive) {
      ultHud.textContent = `${ultimate.abilityName}  ${ultimate.activeStatus()}` // e.g. "ZOMBIE EATER  3/10"
      ultHud.style.color = '#ff7a3c' // active — hot
    } else if (ultimate.ready) {
      ultHud.textContent = `(${ultimate.chargeValue}/${ultimate.maxCharge})  ULTIMATE READY`
      ultHud.style.color = '#37e0ff' // ready — bright crystal
    } else {
      ultHud.textContent = `(${ultimate.chargeValue}/${ultimate.maxCharge})`
      ultHud.style.color = '#5f7488' // charging — dim
    }
  }

  // perf monitor (top-right): REAL frametimes, not the vsync'd display rate —
  //   sim = game update CPU cost (input/AI/anim/effects/camera)
  //   cpu = render submit cost (three → WebGPU encoding)
  //   gpu = measured GPU frame time (timestamp queries, resolved ~5×/s)
  //   eng = uncapped engine throughput = 1000 / max(sim+cpu, gpu) — the number that
  //         matters for "runs on anything"; display fps just shows vsync
  const perf = document.createElement('div')
  perf.id = 'perf'
  perf.style.cssText = 'position:fixed;right:10px;top:10px;color:#9fb2c5;font:11px/1.5 monospace;pointer-events:none;white-space:pre;text-shadow:0 1px 2px #000;text-align:right;'
  overlays.appendChild(perf) // part of the dev-overlay container (hidden in fullscreen)
  let perfLast = 0
  let gpuReadT = 0
  let simMs = 1
  let cpuMs = 1
  let gpuMs = -1
  let frameMsEma = 16.7
  let lastFrameEnd = -1
  const readGpuTime = (): void => {
    const r = renderer as unknown as { resolveTimestampsAsync?: () => Promise<void> }
    if (typeof r.resolveTimestampsAsync !== 'function') return
    r.resolveTimestampsAsync()
      .then(() => {
        const ms = (renderer.info.render as unknown as { timestamp?: number }).timestamp
        if (typeof ms === 'number' && ms > 0) gpuMs = gpuMs < 0 ? ms : gpuMs * 0.9 + ms * 0.1
      })
      .catch(() => {
        /* timestamp-query feature unavailable — eng falls back to CPU-side cost */
      })
  }
  const updatePerf = (t0: number, tRender: number, t1: number): void => {
    simMs = simMs * 0.9 + (tRender - t0) * 0.1
    cpuMs = cpuMs * 0.9 + (t1 - tRender) * 0.1
    if (lastFrameEnd >= 0) frameMsEma = frameMsEma * 0.9 + (t1 - lastFrameEnd) * 0.1
    lastFrameEnd = t1
    if (t1 - gpuReadT > 200) {
      gpuReadT = t1
      readGpuTime()
    }
    if (t1 - perfLast < 250) return
    perfLast = t1
    const r = (renderer.info as unknown as { render: { drawCalls: number; triangles: number } }).render
    const tris = r.triangles >= 1000 ? (r.triangles / 1000).toFixed(1) + 'k' : String(r.triangles)
    const cost = Math.max(simMs + cpuMs, gpuMs > 0 ? gpuMs : 0)
    const eng = cost > 0 ? Math.round(1000 / cost) : 0
    perf.textContent =
      `${Math.round(1000 / frameMsEma)} fps · ${eng} eng\n` +
      `sim ${simMs.toFixed(2)} · cpu ${cpuMs.toFixed(2)} · gpu ${gpuMs > 0 ? gpuMs.toFixed(2) : '—'} ms\n` +
      `${r.drawCalls} draws · ${tris} tris`
  }

  // one bolt per firing-animation loop, from the LEFT HAND bone (the rifle hand)
  let aimPoint: THREE.Vector3 | null = null
  player.onShot = () => {
    if (!aimPoint) return
    const muzzle = player.muzzle()
    const dir = aimPoint.clone().sub(muzzle)
    // one bolt normally; the shotgun ultimate raises pelletsPerShot — each pellet takes its
    // own spread inside spawn(), so a high count + wide spread reads as a shotgun cone
    const pellets = system.params.pelletsPerShot
    for (let p = pellets; p > 0; p--) projectiles.spawn(muzzle, dir)
    fxm.muzzleSpark(muzzle, dir) // tiny 1px sparks off the barrel
    casings.eject(muzzle, dir) // one shell per shot, not per pellet
    if (pellets > 1) {
      // shotgun ultimate: blast, then a pump-rack a beat later
      sfx('shot_shotgun')
      window.setTimeout(() => sfx('shotgun_recock'), 280)
    } else {
      sfx('shot_rifle')
    }
  }

  // fixed camera orientation: aim it ONCE, then only translate — it never rotates
  const CAM_OFFSET = new THREE.Vector3(0, 7.2, 5.2)
  camera.position.copy(player.position).add(CAM_OFFSET)
  camera.lookAt(player.position.x, 0.9, player.position.z - 0.6)
  const camGoal = new THREE.Vector3()

  const clock = new THREE.Clock()
  let stepClock = 0.6 // footstep phase accumulator (2 steps per gait loop)
  // with the post chain the scene renders 2+ times per frame (shadow flush + pass) —
  // reset the counters ourselves so the HUD shows true PER-FRAME totals
  renderer.info.autoReset = false
  const frame = (): void => {
    renderer.info.reset()
    const t0 = performance.now()
    const dt = Math.min(0.05, clock.getDelta())

    // the game proposes a target (nearest living zombie in range); whether the player
    // may fire at it is the CONTROLLER's call (standing stance only). Pacifist mode
    // proposes nothing — no aiming, no shooting.
    aimPoint = null
    if (!pacifist) {
      const px = player.position
      // policy: a valid target is in range AND in line of sight (no wall between — the bolt
      // would be stopped by it anyway). The sticky targeter picks WHICH valid one to hold.
      const cands = horde.targets().filter(
        (t) =>
          t.point.distanceToSquared(px) < FIRE_RANGE * FIRE_RANGE &&
          !(obstacles.length && segmentEntryT(px.x, px.z, t.point.x, t.point.z, obstacles) <= 1),
      )
      aimPoint = targeting.select(cands, px.x, px.z)
    }
    // ultimate: the action button spends a full bar; the active buff ticks down each frame
    if (pollActionPress()) ultimate.activate()
    ultimate.update(dt)

    const move = pollMove()
    const speed = player.update(dt, move, aimPoint)

    // footsteps ride the gait rate: 2 steps per clip loop, loops/s = speed × lpm
    if (speed > 0) {
      const lpm = speed <= system.params.walkSpeedMax ? system.params.playerWalkLpm : system.params.playerRunLpm
      stepClock += 2 * speed * lpm * dt
      if (stepClock >= 1) {
        stepClock -= 1
        sfx('footstep')
      }
    } else stepClock = 0.6 // primed: first step lands quickly after moving again

    // projectiles vs zombies + walls: damage/dismember/death registry-driven; the
    // effects manager decides whether the blood/sparks actually spawn (budgets)
    const shots = projectiles.update(dt, horde.targets())
    for (const hit of shots.hits) {
      const r = horde.hit(hit.target)
      if (!r) continue
      fxm.bloodHit(hit.at, hit.dir) // spray out the exit wound (bolt's travel direction)
      blood.splat(hit.at.x, hit.at.z, 0.3 + Math.random() * 0.25, hit.dir) // small floor splatter
      sfxAt('flesh_hit', hit.at.x, hit.at.y, hit.at.z)
      if (r.severed) sfxAt('dismember', hit.at.x, hit.at.y, hit.at.z)
      if (r.died) {
        sfxAt('zombie_death', hit.at.x, hit.at.y, hit.at.z)
        blood.splat(hit.at.x, hit.at.z, 1.65 + Math.random() * 0.75, undefined, true) // a lingering pool where it fell (50% bigger)
        ultimate.onKill('zombie') // horde kills are zombies (future non-zombie enemies report their own kind)
      }
      hitLog.push(`${(performance.now() / 1000).toFixed(2)}s hp=${r.hp}${r.severed ? ' sever:' + r.severed : ''}${r.died ? ' DIED' : ''}`)
      if (hitLog.length > 120) hitLog.shift()
    }
    for (const at of shots.walls) {
      fxm.wallSpark(at)
      sfxAt('wall_ricochet', at.x, at.y, at.z)
    }

    waves.update(dt, player.position)
    horde.update(dt, player.position)
    fxm.update(dt)
    blood.update(dt)
    casings.update(dt)
    setListener(player.position.x, 1, player.position.z) // spatial audio hears from the player

    // follow camera: translate only (orientation fixed at boot — it never rotates)
    camGoal.copy(player.position).add(CAM_OFFSET)
    camera.position.lerp(camGoal, 1 - Math.exp(-5 * dt))

    const aimTag = player.switching ? ':switching' : player.stance === 'standing' && aimPoint ? ':FIRING' : ''
    hud.textContent =
      `stick ${move.mag.toFixed(2)}  speed ${speed.toFixed(2)} m/s  [${player.stance}${aimTag}]\n` +
      `${waves.status()}  zombies ${horde.aliveCount()}  corpses ${horde.corpseCount()}\n` +
      `sys: run ${system.params.runSpeedMax}  walk ${system.params.walkSpeedMax}  zspd ${system.params.zombieSpeed}  rof ${system.params.fireRate}/s  dmg ${system.params.damage}  sever ${system.params.dismemberChance}`
    updateUltHud()

    const tRender = performance.now() // sim work above, render submit below
    if (post.active()) {
      // r185 LANDMINE: any shadow render nested inside the MRT pass builds the internal
      // 'ShadowMaterial' pipeline against the MRT layout ("targets[1] has no fragment
      // output") and the poisoned pipeline blacks out every later frame. Even a
      // flush-direct-then-settle dance loses the race intermittently. So under the post
      // chain shadows are CACHED — frozen before every pass render, refreshed through
      // flushShadowDirect() on lighting edits only. The default (direct) path below
      // keeps full per-frame dynamic shadows.
      rig.settleShadow()
      post.render()
    } else {
      renderer.render(scene, camera) // dynamic shadows ride along (autoUpdate stays on)
    }
    updatePerf(t0, tRender, performance.now())
  }

  // pure rAF drives visible frames (no double-ticking — an extra interval tick between
  // vsyncs reads as micro-stutter on a moving character); the interval only takes over
  // while the tab is hidden (stalled rAF would freeze the sim + screenshots otherwise).
  const loop = (): void => {
    frame()
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  window.setInterval(() => {
    if (document.hidden) frame()
  }, 33)
}

void start()
