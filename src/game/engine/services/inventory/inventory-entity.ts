import * as THREE from 'three'
import {
  InventoryEntityDeclaration,
  parseInventoryEntityDeclaration,
  type AnimationProfileState,
  type LocomotionBand,
} from '../../../../shared/inventory-schema'
import { loadGltfModel } from '../../../../inventory/gltf'

// every clip name the profile refers to, locomotion bands and lifecycle stagings alike
const profileClips = (profile: AnimationProfileState): string[] => {
  const bands = Object.values(profile.locomotion).flatMap((direction) => (direction ?? []) as readonly LocomotionBand[])
  const lifecycle = Object.values(profile.lifecycle ?? {}).flatMap((play) => (play ? [play.clip] : []))
  return [...bands.map((b) => b.clip), ...lifecycle]
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
const ENTITY_DOCS = import.meta.glob<{ default: unknown }>('/inventory/entities/*/*.json')

type EntityLoaderResult = {
  threeObject: THREE.Object3D
  entityDeclaration: InventoryEntityDeclaration
}

export const loadEntity = async (id: string): Promise<EntityLoaderResult> => {
  const entry = ENTITY_DOCS[`/inventory/entities/${id}/${id}.json`]
  if (!entry) throw new Error(`inventory: no entity '${id}'`)
  const doc = parseInventoryEntityDeclaration(id, (await entry()).default)

  // sibling FBX clips are merged onto the GLB skeleton by the loader
  const model = await loadGltfModel(doc.model.src, doc.model.anims ?? [])

  /*
   Doc-authored size, applied to the INSTANCE root. Safe as a one-time set because
   ThreeSceneSync stamps position and rotation only, never scale. The whole hierarchy scales
   with the root — bones included, and hips-position anim tracks are parent-relative, so
   animation height scales with the body instead of detaching from it.

   This belongs wherever instances are produced: if spawning ever moves to a fresh clone per
   entity (getGltfInstance), this line moves with it.
  */
  model.scene.scale.setScalar(doc.model.scale)

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
    model: { src: '', scale: 1 },
  },
}
