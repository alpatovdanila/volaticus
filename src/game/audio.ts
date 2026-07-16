// Game audio — inventory-driven sfx. Game code asks for SEMANTIC ids ('flesh_hit',
// 'wave_start'); each id is an inventory/sfx doc pointing at sample files, so swapping
// a sound = editing a doc, never game code. Playback runs through the shared engine
// player (src/inventory/sfx.ts): sample cache, random file pick, pitch jitter.
import { validateSfx, type SfxDoc } from '../inventory/schema'
import { ensureAudio, playSfx, preloadSfx, loadSfxBuffer, masterBus } from '../inventory/sfx'

const docs = new Map<string, SfxDoc>()
// eager glob: every inventory/sfx/*.json ships with the page and registers by id
const modules = import.meta.glob('../../inventory/sfx/*.json', { eager: true }) as Record<string, { default: unknown }>
for (const [path, mod] of Object.entries(modules)) {
  const { doc, issues } = validateSfx(mod.default)
  if (doc) docs.set(doc.id, doc)
  else console.warn('sfx doc invalid:', path, issues)
}

const MIN_GAP = 0.05 // s per id — collapses same-frame doubles, keeps rapid fire audible
const lastPlay = new Map<string, number>()

function gated(id: string): SfxDoc | null {
  const doc = docs.get(id)
  if (!doc) return null
  const now = performance.now() / 1000
  if (now - (lastPlay.get(id) ?? -1) < MIN_GAP) return null
  lastPlay.set(id, now)
  return doc
}

// non-positional (UI stings, the player's own sounds)
export function sfx(id: string): void {
  const doc = gated(id)
  if (doc) playSfx(doc)
}

// --- positional playback: world-space voices heard from the PLAYER's position ------
// The listener rides the player (setListener each frame). Camera yaw is fixed, so the
// listener keeps default orientation (-Z forward): world X = stereo pan, exactly what
// the fixed top-down camera shows. Each voice gets its own PannerNode, torn down when
// the take ends.
const REF_DIST = 3 // full volume inside this radius (meters)
const MAX_DIST = 26 // inaudible past the arena diagonal

// global voice budget: per-id MIN_GAP already caps each sound's rate, but a busy horde
// stacks MANY different ids at once — this ceiling stops combat drowning itself in audio
// (and caps the live PannerNode/BufferSource count). New voices past it are dropped.
const MAX_VOICES = 24
let activeVoices = 0

export function setListener(x: number, y: number, z: number): void {
  const ac = ensureAudio()
  if (!ac) return
  const l = ac.listener
  if (l.positionX) {
    l.positionX.value = x
    l.positionY.value = y
    l.positionZ.value = z
  } else l.setPosition(x, y, z) // older API fallback
}

export function sfxAt(id: string, x: number, y: number, z: number): void {
  const doc = gated(id)
  const ac = ensureAudio()
  if (!doc || !ac) return
  if (activeVoices >= MAX_VOICES) return // over budget — drop this voice
  const panner = ac.createPanner()
  panner.panningModel = 'equalpower' // cheap + fine for a fixed top-down camera
  panner.distanceModel = 'linear'
  panner.refDistance = REF_DIST
  panner.maxDistance = MAX_DIST
  panner.positionX.value = x
  panner.positionY.value = y
  panner.positionZ.value = z
  // route through the MASTER bus (like non-positional sounds) — connecting straight to
  // ac.destination bypassed the 0.5 master gain, so world hits played ~2× louder than the
  // player's own shot and the balance felt wrong. One bus = one volume authority.
  panner.connect(masterBus() ?? ac.destination)
  activeVoices++
  playSfx(doc, panner, () => {
    activeVoices--
    panner.disconnect()
  })
}

// Browsers gate audio behind a user gesture (gamepad input does NOT count as one!) —
// resume the context on the first pointer/key event, then start any queued ambience.
let pendingAmbience: string | null = null
let ambienceStarted = false

export function initAudio(): void {
  preloadSfx(docs.values()) // fetch+decode everything off the play path
  const unlock = (): void => {
    void ensureAudio()?.resume().then(() => {
      if (pendingAmbience && !ambienceStarted) startAmbienceNow(pendingAmbience)
    })
  }
  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
  unlock() // in case activation already exists (e.g. reload after interaction)
}

// level ambience: a low looped bed (id comes from the LEVEL definition)
export function startAmbience(id: string): void {
  pendingAmbience = id
  const ac = ensureAudio()
  if (ac && ac.state === 'running' && !ambienceStarted) startAmbienceNow(id)
}

function startAmbienceNow(id: string): void {
  const doc = docs.get(id)
  const ac = ensureAudio()
  if (!doc || !ac) return
  ambienceStarted = true
  void loadSfxBuffer(doc).then((buffer) => {
    if (!buffer) return
    const src = ac.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const g = ac.createGain()
    g.gain.value = doc.volume ?? 0.3
    src.connect(g)
    g.connect(ac.destination)
    src.start()
  })
}
