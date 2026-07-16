// User registry — settings that belong to the PLAYER'S MACHINE, not to a level or a
// run: graphics quality. Persisted to localStorage; the same option set as the editor's
// Render panel (AA mode, GTAO + resolution, anisotropy, tilt-shift). Lighting is NOT
// here — it's level data (level.ts).
export type AAMode = 'off' | 'ssaa2' | 'msaa' | 'msaa_ssaa15'

export interface GraphicsPrefs {
  aa: AAMode // MSAA needs a reload (renderer-creation option); SSAA applies live
  gtao: boolean
  gtaoRes: number // AO buffer resolution scale: 1 | 0.75 | 0.5
  aniso: number // texture anisotropy: 1..16
  tilt: boolean // tilt-shift (diorama) blur
  tiltStrength: number // 0..1
}

const KEY = 'deathterra.graphics'

export const GRAPHICS_DEFAULTS: GraphicsPrefs = {
  aa: 'off',
  gtao: false,
  gtaoRes: 1,
  aniso: 4,
  tilt: false,
  tiltStrength: 0.5,
}

export function loadGraphics(): GraphicsPrefs {
  const p = { ...GRAPHICS_DEFAULTS }
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw) as Partial<GraphicsPrefs>
      if (s.aa === 'off' || s.aa === 'ssaa2' || s.aa === 'msaa' || s.aa === 'msaa_ssaa15') p.aa = s.aa
      p.gtao = s.gtao === true
      if (s.gtaoRes === 1 || s.gtaoRes === 0.75 || s.gtaoRes === 0.5) p.gtaoRes = s.gtaoRes
      if ([1, 2, 4, 8, 16].includes(s.aniso as number)) p.aniso = s.aniso as number
      p.tilt = s.tilt === true
      if (typeof s.tiltStrength === 'number' && s.tiltStrength >= 0 && s.tiltStrength <= 1) p.tiltStrength = s.tiltStrength
    }
  } catch {
    /* non-fatal */
  }
  return p
}

export function saveGraphics(p: GraphicsPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* non-fatal */
  }
}

export const aaRenderScale = (aa: AAMode): number => (aa === 'ssaa2' ? 2 : aa === 'msaa_ssaa15' ? 1.5 : 1)
export const aaMsaa = (aa: AAMode): boolean => aa.startsWith('msaa')
