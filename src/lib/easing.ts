export type EaseName = 'linear' | 'sine' | 'quadIn' | 'quadOut' | 'quadInOut' | 'step'

export const EASE: Record<EaseName, (u: number) => number> = {
  linear: (u) => u,
  sine: (u) => 0.5 - 0.5 * Math.cos(Math.PI * u),
  quadIn: (u) => u * u,
  quadOut: (u) => 1 - (1 - u) * (1 - u),
  quadInOut: (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)),
  step: (u) => (u >= 1 ? 1 : 0),
}
