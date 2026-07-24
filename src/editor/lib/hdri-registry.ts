/*
 The HDRI catalog and the display-transform table — the shared vocabulary for "which sky" and
 "which tone map".

 Split out of lighting.ts so the game can name the same environments as the editor without
 dragging in the editor's lighting RIG (TSL graft nodes, the cached-shadow sun, the GTAO/ambient
 machinery). This module is data plus one loader-choice rule; lighting.ts re-exports it, so the
 editor's existing imports are unaffected.
*/
import * as THREE from 'three'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'

export type ToneMap = 'none' | 'aces' | 'agx'

// A selectable environment: `hdr` lights the scene (PMREM → IBL); `sky`, when present,
// is a separate LDR equirect drawn as the visible background (the stylized set ships
// hand-painted PNG skies next to its .hdr light probes). No `sky` → the light probe
// itself is the sky (the photographic EXRs).
export interface HdriEntry {
  id: string
  name: string
  hdr: string // .exr (EXRLoader) or .hdr/RGBE (RGBELoader) — picked by extension
  sky?: string // LDR equirect for the visible background
}

// the stylized pack: resources/HDRI/stylized HDRI/HDRI_Files/<id>_HDRI_1k.hdr light
// probes (downsampled from the shipped 4k masters — IBL after PMREM can't tell, and
// fetch+prefilter is ~16× cheaper) + sibling <id>.webp skyboxes one level up for most
// (2k WebP re-encodes of the 4k PNG masters: ~100× smaller files, ¼ the VRAM).
// false = no sky twin (the HDR doubles as sky).
const STYLIZED: [string, boolean][] = [
  ['sky_linekotsi_01', true], ['sky_linekotsi_01_b', true], ['sky_linekotsi_01_c', false],
  ['sky_linekotsi_02', true], ['sky_linekotsi_02_b', false],
  ['sky_linekotsi_03', true], ['sky_linekotsi_04', true],
  ['sky_linekotsi_05', true], ['sky_linekotsi_05_b', true], ['sky_linekotsi_05_c', false],
  ['sky_linekotsi_06', true],
  ['sky_linekotsi_07', true], ['sky_linekotsi_07_b', true],
  ['sky_linekotsi_08', true], ['sky_linekotsi_09', true], ['sky_linekotsi_10', true],
  ['sky_linekotsi_11', true], ['sky_linekotsi_12', true], ['sky_linekotsi_13', true],
  ['sky_linekotsi_14', true], ['sky_linekotsi_14_b', true], ['sky_linekotsi_14_c', true],
  ['sky_linekotsi_15', true], ['sky_linekotsi_15_b', true],
  ['sky_linekotsi_16', true], ['sky_linekotsi_17', true], ['sky_linekotsi_18', true],
  ['sky_linekotsi_19', true], ['sky_linekotsi_20', true], ['sky_linekotsi_21', true],
  ['sky_linekotsi_22', true],
  ['sky_linekotsi_23', true], ['sky_linekotsi_23_b', true],
  ['sky_linekotsi_24', true], ['sky_linekotsi_25', true], ['sky_linekotsi_26', true],
  ['sky_linekotsi_27', true], ['sky_linekotsi_28', true],
]

const STYLIZED_DIR = encodeURI('/HDRI/stylized HDRI')

export const HDRIS: HdriEntry[] = [
  { id: 'qwantani_noon_puresky_1k', name: 'Qwantani noon (sky, 1k)', hdr: '/HDRI/qwantani_noon_puresky_1k.exr' },
  { id: 'concrete_tunnel_1k', name: 'Concrete tunnel (1k)', hdr: '/HDRI/concrete_tunnel_1k.exr' },
  { id: 'qwantani_afternoon_puresky_4k', name: 'Qwantani afternoon (sky)', hdr: '/HDRI/qwantani_afternoon_puresky_4k.exr' },
  { id: 'autumn_hilly_field_4k', name: 'Autumn hilly field', hdr: '/HDRI/autumn_hilly_field_4k.exr' },
  { id: 'ticknock_02_4k', name: 'Ticknock', hdr: '/HDRI/ticknock_02_4k.exr' },
  ...STYLIZED.map(([id, png]): HdriEntry => ({
    id,
    // 'sky_linekotsi_05_b' → 'Stylized 05 b'
    name: 'Stylized ' + id.replace('sky_linekotsi_', '').replace(/_/g, ' '),
    hdr: `${STYLIZED_DIR}/HDRI_Files/${id}_HDRI_1k.hdr`,
    sky: png ? `${STYLIZED_DIR}/${id}.webp` : undefined,
  })),
]

export const TONEMAPS: Record<ToneMap, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
}

export const hdriEntry = (id: string): HdriEntry => HDRIS.find((h) => h.id === id) ?? HDRIS[0]

export const hdriExists = (id: string): boolean => HDRIS.some((h) => h.id === id)

// RGBE (.hdr) and OpenEXR are different container formats; the extension is the only
// discriminator, and picking wrong yields a silent decode failure rather than an error.
export const equirectLoaderFor = (url: string) =>
  url.toLowerCase().endsWith('.hdr') ? new RGBELoader() : new EXRLoader()
