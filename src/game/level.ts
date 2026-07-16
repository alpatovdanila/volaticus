// Level definition — the proto file format for game levels. LIGHTING LIVES WITH THE
// LEVEL (an artistic call made against the room, like the editor's light panel is made
// against the current sky), while GRAPHICS settings live with the USER (userPrefs.ts).
// There is no level controller / on-disk format yet — this module IS the storage until
// one exists; the shape is what a future levels/*.json would carry.
import type { LightParams } from '../lib/lighting'
import type { OrbConfig } from './orbs'
import { TEST_WAVE, type WaveDef } from './waves'

export interface InteriorWall {
  x: number // centre X
  z: number // centre Z
  w: number // full width (X)
  d: number // full depth (Z)
}

export interface LevelDef {
  name: string
  arenaHalf: number // walls at ±half; player clamped inside
  floorMat: string // material catalog ids
  wallMat: string
  interiorWalls?: InteriorWall[] // free-standing cover inside the arena (same wall material)
  lights: Partial<LightParams> // merged over LIGHT_DEFAULTS at load
  // static fill lights (level dressing; intensity tuned live, NOT in registry). The COLOUR
  // is not stored here — it's set from the bullet tracer colour at boot (single source of
  // truth) so the orbs glow the same warm orange as the shots.
  orbs?: Omit<OrbConfig, 'color'>
  ambience?: string // inventory sfx id, looped as the level's sound bed
  wave: WaveDef
}

export const TEST_LEVEL: LevelDef = {
  name: 'testing-grounds',
  arenaHalf: 11,
  floorMat: 'floor_tiles_02',
  wallMat: 'bricks_wall_13',
  lights: {
    hdri: 'sky_linekotsi_21', // "Stylized 21"
    tonemap: 'aces',
    rotation: 149,
    intensity: 0.25, // faint HDRI fill over the placed lights (orbs, crystals, shots)
    hideBg: true, // arena sits in black void (setHiddenBackground below)
    ao: 0.85,
    flat: false,
    shadowSoft: 3,
    shadow: 0, // no sun shadow — there's no sun contribution to cast one
    ambient: 0.02, // a whisper of flat lift so unlit crevices aren't pure black
  },
  // a couple of free-standing cover walls (thickness 0.7); offset from the centre spawn
  interiorWalls: [
    { x: -4, z: -3, w: 6, d: 0.7 },
    { x: 5, z: 2.5, w: 0.7, d: 5 },
    { x: 1.5, z: 6, w: 4, d: 0.7 },
  ],
  orbs: { count: 5, intensity: 2.5, radius: 8.5, height: 0.35 }, // colour comes from the bullet tracer
  ambience: 'ambience_cave',
  wave: TEST_WAVE,
}
