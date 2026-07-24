import * as THREE from 'three'
import { PMREMGenerator } from 'three/webgpu'

import { equirectLoaderFor, hdriEntry } from '../../../../lib/hdri-registry'
import type { KnownServices } from '../../services-registry'
import type { LevelDeclaration } from './level-schema'

/*
 Builds a level's image-based lighting from its `environment` block: the HDRI probe is
 PMREM-prefiltered into scene.environment, and its yaw/strength/tone map come from the same
 declaration. Awaited by World.loadLevel next to LevelLoader, so a level is lit by the time it
 is announced — lighting is one of the things loading a level means, not a reaction to it.

 The light lives on the SCENE (scene.environment / environmentIntensity / environmentRotation),
 never as a per-material envMap snapshot. A material holding a pointer to a PMREM texture keeps
 pointing at it after an environment swap disposes it — the components goes black and never recovers.
 Scene properties are re-read every frame, so they survive swaps.
*/
export class EnvironmentLoader {
  constructor(
    private declaration: LevelDeclaration,
    private renderer: KnownServices['renderer'],
  ) {}

  async loadAndAttach(scene: THREE.Scene) {
    const declaration = this.declaration.scene.environment
    if (!declaration) return

    this.renderer.setToneMapping(declaration.tonemap, scene)
    scene.environmentIntensity = declaration.intensity

    // one Euler drives sky and IBL together, so rotating the environment turns the light with
    // the visible sun rather than sliding them apart
    const yaw = new THREE.Euler(0, THREE.MathUtils.degToRad(declaration.rotation), 0)
    scene.environmentRotation.copy(yaw)
    scene.backgroundRotation.copy(yaw)

    const entry = hdriEntry(declaration.hdri)
    // the stylized pack ships a hand-painted LDR sky beside its probe; the photographic EXRs
    // are their own sky. Either way the probe equirect is only needed until PMREM captures it.
    const [probe, sky] = await Promise.all([
      equirectLoaderFor(entry.hdr).loadAsync(entry.hdr),
      entry.sky ? new THREE.TextureLoader().loadAsync(entry.sky) : null,
    ])

    probe.mapping = THREE.EquirectangularReflectionMapping

    const pmrem = new PMREMGenerator(this.renderer.getThreeRenderer())
    scene.environment = pmrem.fromEquirectangular(probe).texture
    pmrem.dispose()

    const background = sky ?? probe
    if (sky) {
      sky.mapping = THREE.EquirectangularReflectionMapping
      sky.colorSpace = THREE.SRGBColorSpace
      probe.dispose()
    }

    // showSky false keeps the lighting but leaves the level's flat `background` colour visible
    if (declaration.showSky) scene.background = background
    else background.dispose()
  }
}
