import * as THREE from 'three'
import {
  ModelDeclaration,
  parseModelDeclaration,
  type AnimationProfileState,
  type LocomotionBand,
} from '../../../../../inventory/schemas/model.schema'
import { loadGltfModel } from '../../../../inventory/gltf'

// every clip name the profile refers to, locomotion bands and lifecycle stagings alike
const profileClips = (profile: AnimationProfileState): string[] => {
  const bands = Object.values(profile.locomotion ?? {}).flatMap(
    (direction) => (direction ?? []) as readonly LocomotionBand[],
  )
  const events = [...Object.values(profile.lifecycle ?? {}), ...Object.values(profile.actions ?? {})]
  return [...bands.map((b) => b.clip), ...events.flatMap((play) => (play ? [play.clip] : []))]
}

/*
 A clip the profile names but the model never shipped would freeze the character silently, so
 the two are checked against each other here — the one moment doc and clips are both in hand.
*/
const getMissingClips = (profile: AnimationProfileState, clips: { name: string }[]) => {
  const available = new Set(clips.map((c) => c.name))
  return [...new Set(profileClips(profile))].filter((c) => !available.has(c))
}

// globbed as unknown: the doc is validated on load, never asserted
const ENTITY_DOCS = import.meta.glob<{ default: unknown }>('/inventory/models/*/*.json')

type EntityLoaderResult = {
  threeObject: THREE.Object3D
  entityDeclaration: ModelDeclaration
}

export const loadEntity = async (id: string): Promise<EntityLoaderResult> => {
  const entry = ENTITY_DOCS[`/inventory/entities/${id}/${id}.json`]
  if (!entry) throw new Error(`inventory: no entity '${id}'`)
  const doc = parseModelDeclaration(id, (await entry()).default)

  // clips are already baked into the GLB (inventory/scripts/bake-gltf-animations.ts)
  const model = await loadGltfModel(doc.model.src)

  // For now, we are thrusting the incoming format to be valid to simplify the loader
  if (doc.animationProfile) {
    const missingClips = getMissingClips(doc.animationProfile, model.clips)
    if (missingClips.length) {
      delete doc.animationProfile
      missingClips.forEach((clip) => console.log(`${doc.id}/${clip} clip is missing`))
      console.warn(
        `Inventory Entity ${doc.id} AnimationProfile was invalidated since there are missing clips. Entity will not be animated`,
      )
    }
  }

  return {
    threeObject: model.scene,
    entityDeclaration: doc,
  }
}

export const DUMMY_ENTITY: EntityLoaderResult = {
  threeObject: new THREE.Object3D(),
  entityDeclaration: {
    id: '__dummy',
    model: { src: '' },
  },
}
