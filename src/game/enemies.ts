// Enemy archetypes — the per-type GAME data the horde needs that the entity doc
// deliberately does NOT carry. The doc format is shared with the editor, so gameplay
// concerns (hit points, aim height, body radius, which fact-kind this species reports)
// live here instead of leaking into inventory/schema.ts.
//
// Adding an enemy = one record here + its entity doc. Nothing inside the Horde changes:
// clip NAMES are data too, so a species with differently-named animations just works.
import type { EntityDoc } from '../inventory/schema'
import { validatedDoc } from './entityDoc'
import alyoshaRaw from '../../inventory/entities/alyosha/alyosha.json'

export interface EnemyDef {
  doc: EntityDoc
  // gameplay kind reported on enemy facts. NOT the entity-doc id: several species can be
  // 'zombie' (what ZOMBIE EATER counts), and one species could be re-skinned without
  // changing what it counts as. See docs/DD_NOTES.md.
  kind: string
  hp: number
  aimHeight: number // bolts aim/hit this high above the body origin
  radius: number // body radius for separation + interior-wall push-out
  clips: { walk: string; death: string; rise: string }
  // the mesh whose material dresses this species' CORPSES (corpses.ts bakes one static
  // skin per type from it). Data, not a guess: picking it by a hardcoded name with a
  // positional fallback would silently clone whatever mesh happened to be first — and if
  // that were the @exposeEmissive part, every corpse of the species would glow.
  skinPart: string
}

// docs validate at module load — an invalid doc throws at boot, not mid-wave
export const ENEMIES: Record<string, EnemyDef> = {
  alyosha: {
    doc: validatedDoc(alyoshaRaw, 'alyosha'),
    kind: 'zombie',
    hp: 5,
    aimHeight: 0.7, // alyosha is squat — chest height
    radius: 0.35,
    clips: { walk: 'Walking', death: 'Zombie Death', rise: 'index' },
    skinPart: 'body', // NOT 'crystals' — the corpse wears the flesh, whose glow is long gone
  },
}
