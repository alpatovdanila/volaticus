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

// The complete vocabulary of sounds the game can ask for. It's a closed list so it can be
// CHECKED: an unknown id is otherwise silent forever (gated() just returns null), which
// means renaming an inventory doc removes a sound from the game and nothing says a word.
// assertSfxIds() at boot turns that into a loud failure at the only moment it's cheap.
// Level/weapon ids are validated the same way, from their own data (see main.ts).
export const GAME_SFX = ['footstep', 'flesh_hit', 'dismember', 'zombie_death', 'zombie_rise', 'wall_ricochet'] as const

// throws unless every id resolves to an inventory/sfx doc
export function assertSfxIds(ids: readonly string[]): void {
  const missing = [...new Set(ids)].filter((id) => !docs.has(id))
  if (missing.length) throw new Error(`audio: no sfx doc for id(s) "${missing.join('", "')}" — check inventory/sfx/*.json`)
}

const MIN_GAP = 0.05 // s per id — collapses same-frame doubles, keeps rapid fire audible
const lastPlay = new Map<string, number>()
const warned = new Set<string>()

// WALL-CLOCK, deliberately (not the sim clock): this guards the listener's EAR against
// same-instant doubles — a real-world concern that must keep working while the sim is
// paused, and that means nothing in game-seconds. See clock.ts.
function gated(id: string): SfxDoc | null {
  const doc = docs.get(id)
  if (!doc) {
    // boot's assertSfxIds should have caught this; if we're here, something asked for an
    // id that isn't in the vocabulary. Say so once rather than going quietly silent.
    if (!warned.has(id)) {
      warned.add(id)
      console.error(`audio: unknown sfx id "${id}" — no inventory/sfx doc; this sound will never play`)
    }
    return null
  }
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
  const ac = ensureAudio()
  if (!ac) return
  // BUDGET BEFORE GATE: gated() stamps the id's MIN_GAP window as a side effect, so
  // checking the budget afterwards meant a voice we dropped still blocked its own id for
  // the next 50ms — the sound went quiet exactly when the fight was busiest.
  if (activeVoices >= MAX_VOICES) return // over budget — drop this voice
  const doc = gated(id)
  if (!doc) return
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
    g.connect(masterBus() ?? ac.destination) // the master bus is the ONE volume authority
    src.start()
  })
}
