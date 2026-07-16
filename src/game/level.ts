// Level definition — the proto file format for game levels. LIGHTING LIVES WITH THE
// LEVEL (an artistic call made against the room, like the editor's light panel is made
// against the current sky), while GRAPHICS settings live with the USER (userPrefs.ts).
// There is no level controller / on-disk format yet — this module IS the storage until
// one exists; the shape is what a future levels/*.json would carry.
import type { LightParams } from '../lib/lighting'
import type { OrbConfig } from './orbs'
import { TEST_WAVE, type WaveDef } from './waves'

export interface LevelDef {
  name: string
  arenaHalf: number // walls at ±half; player clamped inside
  floorMat: string // material catalog ids
  wallMat: string
  lights: Partial<LightParams> // merged over LIGHT_DEFAULTS at load
  orbs?: OrbConfig // static warm fill lights (level dressing; intensity tuned live, NOT in registry)
  ambience?: string // inventory sfx id, looped as the level's sound bed
  wave: WaveDef
}

export const TEST_LEVEL: LevelDef = {
  name: 'testing-grounds',
  arenaHalf: 11,
  floorMat: 'floor_tiles_02',
  wallMat: 'stone_wall_03',
  lights: {
    hdri: 'sky_linekotsi_21', // "Stylized 21"
    tonemap: 'aces',
    rotation: 149,
    intensity: 2.05,
    hideBg: true, // arena sits in black void (setHiddenBackground below)
    ao: 0.85,
    flat: false,
    shadowSoft: 3,
    shadow: 0.35,
    ambient: 0.04,
  },
  orbs: { count: 5, color: '#ff9a4a', intensity: 6, radius: 8.5, height: 0.35 },
  ambience: 'ambience_cave',
  wave: TEST_WAVE,
}
