// All game audio is synthesized from small JSON patches (inventory/sfx/*.json).
import type { SfxDoc } from './schema'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let mapGate: GainNode | null = null
let mapMuted = false
let noiseBuffer: AudioBuffer | null = null

export function ensureAudio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
    mapGate = ctx.createGain()
    mapGate.gain.value = mapMuted ? 0 : 1
    mapGate.connect(master)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

// read-only handle (no create/resume side effects) — game code polls the state
// to defer emitter loops until the first user gesture unlocks playback
export function audioContext(): AudioContext | null {
  return ctx
}

// the final output — explicit ▶ preview buttons connect here so they stay
// audible while the map gate is muted
export function masterBus(): AudioNode | null {
  ensureAudio()
  return master
}

// the map bus carries every level-driven sound (enemies, effects, emitters,
// zone music). setSfxMuted() is the single gate a "play map sounds" toggle
// flips — a bus-side gain, so live loops keep phase and resume seamlessly.
export function mapBus(): AudioNode | null {
  ensureAudio()
  return mapGate
}

export function setSfxMuted(muted: boolean): void {
  mapMuted = muted
  if (mapGate && ctx) mapGate.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.03)
}

export function sfxMuted(): boolean {
  return mapMuted
}

function getNoise(ac: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    noiseBuffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return noiseBuffer
}

// sample files (paths relative to resources/), decoded once and cached
const sampleCache = new Map<string, Promise<AudioBuffer | null>>()

function loadSample(ac: AudioContext, path: string): Promise<AudioBuffer | null> {
  let p = sampleCache.get(path)
  if (!p) {
    p = fetch('/' + encodeURI(path))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${path}`))))
      .then((buf) => ac.decodeAudioData(buf))
      .catch((e) => {
        console.warn('sfx sample failed:', e)
        return null
      })
    sampleCache.set(path, p)
  }
  return p
}

function playSample(ac: AudioContext, doc: SfxDoc, jitter: number, dest: AudioNode, onEnded?: () => void): void {
  const files = doc.files!
  const path = files[Math.floor(Math.random() * files.length)]
  void loadSample(ac, path).then((buffer) => {
    if (!buffer) {
      onEnded?.()
      return
    }
    const src = ac.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = jitter
    const g = ac.createGain()
    g.gain.value = doc.volume ?? 0.8
    src.connect(g)
    g.connect(dest)
    if (onEnded) src.onended = onEnded
    src.start()
  })
}

// synth docs: when the last layer's envelope closes. Sample docs report 0 —
// their length lives in the decoded buffer (see loadSfxBuffer).
export function sfxDuration(doc: SfxDoc): number {
  let end = 0
  for (const layer of doc.layers ?? []) end = Math.max(end, (layer.start ?? 0) + layer.duration)
  return end
}

// decoded buffer of a sample-form doc, for loop playback (random pick, cached)
export function loadSfxBuffer(doc: SfxDoc): Promise<AudioBuffer | null> {
  const ac = ensureAudio()
  const files = doc.files
  if (!ac || !files?.length) return Promise.resolve(null)
  return loadSample(ac, files[Math.floor(Math.random() * files.length)])
}

// Boot-time warmup: fetch + decode EVERY sample file of every sample-form doc
// into the shared cache (the same one loadSfxBuffer/playSample read), so the
// first play of any sound skips the fetch+decode latency. decodeAudioData runs
// off the main thread — fire-and-forget, callers never await this. The context
// starts suspended before the first user gesture; decoding still works.
export function preloadSfx(docs: Iterable<SfxDoc>): void {
  const ac = ensureAudio()
  if (!ac) return
  getNoise(ac) // synth noise layers share one generated buffer — build it off the play path too
  for (const doc of docs) for (const path of doc.files ?? []) void loadSample(ac, path)
}

function applyEnv(
  param: AudioParam,
  from: number,
  to: number,
  t0: number,
  dur: number,
  curve: 'lin' | 'exp',
): void {
  const min = 0.0001
  param.setValueAtTime(Math.max(curve === 'exp' ? min : 0, from), t0)
  if (curve === 'exp') param.exponentialRampToValueAtTime(Math.max(min, to), t0 + dur)
  else param.linearRampToValueAtTime(to, t0 + dur)
}

// dest defaults to the master bus (editor previews, player sounds). Spatial
// playback passes a PannerNode routed into the map bus; onEnded lets the
// caller tear that per-voice chain down once the take finishes.
export function playSfx(doc: SfxDoc, dest?: AudioNode, onEnded?: () => void): void {
  const ac = ensureAudio()
  if (!ac || !master) {
    onEnded?.()
    return
  }
  const sink = dest ?? master
  const now = ac.currentTime + 0.01
  const jitter =
    (doc.pitch ?? 1) * (doc.pitchJitter ? Math.pow(2, (Math.random() * 2 - 1) * doc.pitchJitter) : 1)

  if (doc.files) {
    playSample(ac, doc, jitter, sink, onEnded)
    return
  }

  const out = ac.createGain()
  out.gain.value = doc.volume ?? 0.8
  out.connect(sink)
  if (onEnded) setTimeout(onEnded, (sfxDuration(doc) + 0.15) * 1000)

  for (const layer of doc.layers ?? []) {
    const t0 = now + (layer.start ?? 0)
    const dur = layer.duration
    const curve = layer.curve ?? 'exp'
    const g = ac.createGain()
    applyEnv(g.gain, layer.gain?.from ?? 1, layer.gain?.to ?? 0, t0, dur, curve)
    g.connect(out)

    if (layer.type === 'tone') {
      const osc = ac.createOscillator()
      osc.type = layer.wave
      if ('steps' in layer.freq) {
        for (const [t, hz] of layer.freq.steps) osc.frequency.setValueAtTime(hz * jitter, t0 + t)
      } else {
        const from = layer.freq.from * jitter
        const to = (layer.freq.to ?? layer.freq.from) * jitter
        applyEnv(osc.frequency, from, to, t0, dur, 'exp')
      }
      osc.connect(g)
      osc.start(t0)
      osc.stop(t0 + dur + 0.02)
    } else {
      const src = ac.createBufferSource()
      src.buffer = getNoise(ac)
      src.loop = true
      src.playbackRate.value = jitter
      let head: AudioNode = src
      if (layer.filter) {
        const f = ac.createBiquadFilter()
        f.type = layer.filter.type
        f.Q.value = layer.filter.q ?? 1
        applyEnv(f.frequency, layer.filter.from, layer.filter.to ?? layer.filter.from, t0, dur, 'exp')
        head.connect(f)
        head = f
      }
      head.connect(g)
      src.start(t0)
      src.stop(t0 + dur + 0.02)
    }
  }
}
