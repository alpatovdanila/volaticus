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
import { type EntityDoc, type MaterialCatalogDoc } from '../inventory/schema'
import { validatedDoc } from './entityDoc'
import { ENEMIES } from './enemies'
import { EffectSystem } from '../inventory/effects'
import { configureKtx2, setMaterialCatalog, makeSlotMaterial, whenTexturesReady, setAnisotropy } from '../inventory/materials'
import { pollMove, pollActionPress } from './input'
import { UltimateController, ZombieEaterUltimate } from './ultimate'
import { PlayerController } from './player'
import { BOLT_COLOR } from './projectiles'
import { LightPool } from './lights'
import { Orbs } from './orbs'
import { Horde } from './zombies'
import { WaveController } from './waves'
import { GameEvents } from './events'
import { CombatSystem } from './combat'
import { EffectsManager } from './effectsManager'
import { BloodSplatters } from './blood'
import { CorpseBatch } from './corpses'
import { Casings } from './casings'
import { boxFrom, type Box } from './obstacles'
import { system } from './system'
import { sim } from './clock'
import { mountDevChrome } from './devChrome'
import { mountUltHud, mountDebugHud, PerfHud, type RendererView } from './hud'
import { TEST_LEVEL } from './level'
import { loadGraphics, aaRenderScale, aaMsaa } from './userPrefs'
import { PostChain } from './post'
import { initAudio, setListener, startAmbience, assertSfxIds, GAME_SFX } from './audio'
import { weaponSfxIds } from './weapons'
import marineRaw from '../../inventory/entities/marine2/marine2.json'

// the dev server suppresses full reloads for src/** unless the page opts in
scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/'])

const level = TEST_LEVEL
const ARENA_HALF = level.arenaHalf
const PLAYER_RADIUS = 0.45
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

  const marineDoc = validatedDoc(marineRaw, 'marine2')

  // player controller: owns the stance machine (moving → settling → standing), analog
  // locomotion, movement integration and the hand-bone muzzle. Input stays external.
  const playerBuilt = await buildEntity(marineDoc, new THREE.Vector3(0, 0, 0), 0)
  const player = new PlayerController(playerBuilt, ARENA_HALF, PLAYER_RADIUS, obstacles)

  // shared effect system + the game-facing manager (semantic calls, budgets, throttling)
  const effects = new EffectSystem(scene)
  const fxm = new EffectsManager(effects)
  const blood = new BloodSplatters(scene) // reflective floor decals (hits + death pools)
  const casings = new Casings(scene) // ejected shell casings (hot → cool, batched on the floor)

  // sounds are inventory-driven: these ids resolve to inventory/sfx docs → files. Validate
  // the whole vocabulary NOW (the game's, every weapon's, the level's) — a renamed doc is
  // a boot error here instead of a sound that silently stops existing.
  assertSfxIds([...GAME_SFX, ...weaponSfxIds(), ...(level.ambience ? [level.ambience] : [])])
  initAudio()
  if (level.ambience) startAmbience(level.ambience)

  // dead zombies bake into this batch (few draw calls for the whole battlefield); the wave
  // counter is stamped on each corpse (survival policy + HUD)
  const corpseBatch = new CorpseBatch(scene)
  // the gameplay-fact bus: producers report, everyone else subscribes (events.ts)
  const events = new GameEvents()
  // ENEMIES is the archetype table (enemies.ts): hp/aim height/radius/clip names per species
  const horde = new Horde(scene, ENEMIES, effects, events, zombieLights, corpseBatch, obstacles)
  const waves = new WaveController(horde, level.wave, events) // ctor validates the composition

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

  // ultimate: kills charge the bar; the action button spends it on ZOMBIE EATER (shotgun)
  const ultimate = new UltimateController(new ZombieEaterUltimate())
  // combat owns aim policy, the fire path and the hit fan-out (combat.ts); it subscribes
  // the presentation reactions to the fact bus and wires itself to the player's shot/step
  const combat = new CombatSystem({ scene, events, horde, player, fx: fxm, blood, casings, ultimate, obstacles, arenaHalf: ARENA_HALF, boltLights: lightPool })

  // dev chrome: the overlay container + fullscreen toggle + the panels. Everything a
  // developer needs and a player must never see goes in here (fullscreen hides it all).
  const overlays = mountDevChrome({
    hud,
    // settings: lighting edits the LEVEL's data live, graphics edits the user registry
    settings: {
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
    // animation↔ground coupling sliders (tune, then graduate values into DEFAULT_PARAMS)
    sliders: [
      { key: 'playerWalkLpm', label: 'player walk l/m', min: 0.05, max: 2, step: 0.01 },
      { key: 'playerRunLpm', label: 'player run l/m', min: 0.05, max: 2, step: 0.01 },
      { key: 'zombieWalkLpm', label: 'zombie walk l/m', min: 0.05, max: 2, step: 0.01 },
      { key: 'zombieLightIntensity', label: 'zombie light', min: 0, max: 8, step: 0.1 },
      { key: 'targetStickiness', label: 'target stick', min: 0, max: 1, step: 0.05 },
    ],
    buttons: [
      {
        // pacifist: no aiming/shooting at all + player invincible (tweak animations in
        // peace). Combat holds the guns, the player holds the immunity.
        label: 'pacifist',
        isOn: () => combat.pacifist,
        onClick: () => {
          combat.pacifist = !combat.pacifist
          player.invincible = combat.pacifist
        },
      },
      { label: 'clear wave', onClick: () => horde.killAll() },
    ],
  })

  ;(window as unknown as { __game: unknown }).__game = { player, horde, waves, effects, blood, casings, ultimate, combat, events, scene, camera, renderer, rig, post, hitLog: combat.hitLog }

  // frame-scoped state the HUD getters read back. DECLARED BEFORE the getters that close
  // over them — a `let` used inside a closure defined above its declaration is a temporal
  // dead zone waiting for someone to call it one line too early.
  let aimPoint: THREE.Vector3 | null = null
  let lastMove = { x: 0, y: 0, mag: 0 }
  let lastSpeed = 0

  // readouts: the ult bar is gameplay UI (stays visible in fullscreen); the debug line and
  // perf monitor are dev chrome (parented into the overlay container)
  const updateUltHud = mountUltHud(() => ultimate)
  const updateDebugHud = mountDebugHud(hud, () => ({
    stickMag: lastMove.mag,
    speed: lastSpeed,
    stance: player.stance,
    switching: player.switching,
    aimed: aimPoint !== null,
    waveStatus: waves.status(),
    alive: horde.aliveCount(),
    corpses: horde.corpseCount(),
    params: system.params,
  }))
  const perf = new PerfHud(renderer as unknown as RendererView, overlays)

  // fixed camera orientation: aim it ONCE, then only translate — it never rotates
  const CAM_OFFSET = new THREE.Vector3(0, 7.2, 5.2)
  camera.position.copy(player.position).add(CAM_OFFSET)
  camera.lookAt(player.position.x, 0.9, player.position.z - 0.6)
  const camGoal = new THREE.Vector3()

  const clock = new THREE.Clock()
  // with the post chain the scene renders 2+ times per frame (shadow flush + pass) —
  // reset the counters ourselves so the HUD shows true PER-FRAME totals
  renderer.info.autoReset = false
  const frame = (): void => {
    renderer.info.reset()
    const t0 = performance.now()
    const dt = Math.min(0.05, clock.getDelta())
    sim.tick(dt) // THE sim clock — ticked exactly once, here. Everything gameplay reads sim.now.

    // ONE horde snapshot per frame, shared by aiming and by bolt collision. horde.targets()
    // hands back a reused buffer, so calling it twice would rewrite the points the first
    // call's consumers are still holding.
    const targets = horde.targets()

    // ORDER MATTERS: combat proposes the aim → the player acts on it (and fires from
    // inside its animation loop) → combat resolves the bolts that are now in the air.
    aimPoint = combat.chooseTarget(targets)
    // ultimate: the action button spends a full bar; the active buff ticks down each frame
    if (pollActionPress()) ultimate.activate()
    ultimate.update(dt)

    lastMove = pollMove()
    lastSpeed = player.update(dt, lastMove, aimPoint)
    combat.update(dt, targets)

    waves.update(dt, player.position)
    horde.update(dt, player.position)
    fxm.update(dt)
    blood.update(dt)
    casings.update(dt)
    setListener(player.position.x, 1, player.position.z) // spatial audio hears from the player

    // follow camera: translate only (orientation fixed at boot — it never rotates)
    camGoal.copy(player.position).add(CAM_OFFSET)
    camera.position.lerp(camGoal, 1 - Math.exp(-5 * dt))

    updateDebugHud()
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
    perf.update(t0, tRender, performance.now())
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
