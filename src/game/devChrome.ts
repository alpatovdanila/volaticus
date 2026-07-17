// Dev chrome — the developer-facing furniture around the game: the overlay container, the
// fullscreen toggle, and the tuning/settings panels.
//
// It exists so ONE rule can be enforced in one place: everything a developer needs and a
// player must never see lives inside #overlays, and entering fullscreen hides that
// container wholesale — a clean play/capture view with no per-widget bookkeeping. The ult
// bar deliberately stays outside it: that's gameplay UI.
import { mountTuningPanel, type TuningField, type DevButton } from './tuning'
import { mountSettingsPanel, type Hooks as SettingsHooks } from './settings'

export interface DevChromeOpts {
  hud: HTMLElement // the debug readout (reparented in from <body>)
  settings: SettingsHooks
  sliders: TuningField[]
  buttons: DevButton[]
}

// returns the overlay container — parent anything else dev-only to it
export function mountDevChrome(o: DevChromeOpts): HTMLElement {
  const overlays = document.createElement('div')
  overlays.id = 'overlays'
  document.body.appendChild(overlays)
  overlays.appendChild(o.hud)

  document.addEventListener('fullscreenchange', () => {
    overlays.style.display = document.fullscreenElement ? 'none' : ''
  })
  // 'F' toggles fullscreen (keydown is a user gesture, so requestFullscreen is allowed)
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF') return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  })

  mountSettingsPanel(o.settings, overlays)
  mountTuningPanel(o.sliders, o.buttons, overlays)
  return overlays
}
