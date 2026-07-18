// The Mixamo FBX -> GLB clip retarget, shared by the runtime loader (gltf.ts) and the offline
// baker (scripts/bake-anims.ts). Deliberately free of three/webgpu, fetch and DOM so it runs
// unchanged under node: callers hand in ALREADY-LOADED objects, this module only does math.
// One implementation means a baked clip is bit-identical to what the runtime used to compute.
import * as THREE from 'three'

// Cumulative forward distance of the hips over a clip, in GLB meters — the clip's
// AUTHORED root motion. Projected onto the clip's net travel direction so lateral sway
// doesn't count as distance. Returns null for in-place clips (net travel ≈ 0): there is
// no authored profile to follow, hosts fall back to constant-speed + loops-per-meter.
export interface RootMotionProfile {
  times: number[]
  dist: number[] // cumulative meters at each time; monotonic
  total: number // meters covered by one full loop
}

export interface FbxAnimSource {
  name: string // clip name (the fbx filename without extension)
  root: THREE.Object3D // the parsed FBX root, carrying .animations
}

// Merge sibling Mixamo FBX clips onto the GLB. Both come from the SAME Mixamo rig, and three's
// loaders strip the ':' from bone names on BOTH sides, so the FBX clip's bone track names
// ("mixamorigHips.quaternion") already match the GLB's Bone objects — the clip binds directly,
// with NO retargeting (retargetClip frame-samples + poses the shared target skeleton, corrupting
// the clones). Track policy: ROTATION tracks for every bone, plus the HIPS HEIGHT (Y) — see the
// retarget in the loop; all other position tracks carry FBX-unit root motion that doesn't fit
// the GLB's scaled armature, so the animation plays in place at the right size. Corrections:
// the HIPS gets the GLB rest premultiplied (root curves are identity-framed — Mixamo's pre-
// rotation lives on the rig node, never in the curves); every OTHER bone gets the per-bone
// rig-rest delta rest_glb·rest_fbx⁻¹ (identity when the rigs truly match, so same-rig models
// pass through untouched; auto-rigged GLBs with different bind poses land in the right frame).
//
// A merged clip with the same NAME as a baked GLB clip intentionally OVERRIDES it at play time
// (clips list is [...glb, ...merged]; the by-name map keeps the last) — some Blender exports bake
// the NLA in the wrong frame (the marine lay face-down), while the FBX sources are ground truth.
export function mergeFbxClips(scene: THREE.Object3D, sources: FbxAnimSource[]): THREE.AnimationClip[] {
  // GLB bone rests — the frame the clips must land in
  const glbRest = new Map<string, THREE.Quaternion>()
  let hipsName = ''
  let glbHips: THREE.Object3D | null = null
  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      if (!glbRest.has(o.name)) glbRest.set(o.name, (o as THREE.Bone).quaternion.clone())
      if (/Hips$/.test(o.name) && !hipsName) {
        hipsName = o.name
        glbHips = o
      }
    }
  })
  // GLB-side hips BIND data for the height retarget below — world-space (of the gltf scene)
  // so armature-node rotations/scales cancel; the emitted track values are hips-local.
  scene.updateMatrixWorld(true)
  const glbHipsWorld = glbHips ? (glbHips as THREE.Object3D).getWorldPosition(new THREE.Vector3()) : null
  const glbHipsParentInv = (glbHips as THREE.Object3D | null)?.parent?.matrixWorld.clone().invert() ?? null
  const out: THREE.AnimationClip[] = []

  for (const source of sources) {
    try {
      const fbx = source.root
      const clip = (fbx as unknown as { animations: THREE.AnimationClip[] }).animations?.[0]
      if (!clip) {
        console.warn('anim merge: no clip in', source.name)
        continue
      }
      // FBX rig bone rests. Auto-rigged GLBs (Tripo) reuse Mixamo bone NAMES but with
      // DIFFERENT bind orientations — raw curve transfer then lands near-T-pose. The
      // same-topology retarget is per-bone: q_glb(t) = rest_glb · rest_fbx⁻¹ · q_fbx(t)
      // (identity when the rigs truly match, so same-rig models are untouched).
      const fbxRest = new Map<string, THREE.Quaternion>()
      fbx.traverse((o) => {
        if ((o as THREE.Bone).isBone && !fbxRest.has(o.name)) fbxRest.set(o.name, (o as THREE.Bone).quaternion.clone())
      })
      const tracks: THREE.KeyframeTrack[] = clip.tracks
        .filter((t) => /\.quaternion$/.test(t.name))
        .map((t) => {
          const c = t.clone() as THREE.QuaternionKeyframeTrack
          const bone = c.name.replace(/\.quaternion$/, '')
          const rg = glbRest.get(bone)
          if (!rg) return c
          if (bone === hipsName) {
            // Hips: plain rest premultiply. The root curves are identity-framed (Mixamo pre-
            // rotation lives on the rig node, not in the curves), so composing the GLB rest in
            // front lands them upright. (Self-calibrating to the clip's first key looked clever
            // but offset every clip by its lead-in lean — a constant ~7° tilt on idles.)
            premultiplyTrack(c, rg)
          } else {
            const rf = fbxRest.get(bone)
            if (rf) {
              const corr = rg.clone().multiply(rf.clone().invert())
              if (Math.abs(1 - Math.abs(corr.w)) > 1e-4) premultiplyTrack(c, corr) // skip ≈identity
            }
          }
          return c
        })
      // HIPS HEIGHT: rotations alone can't ground a character — pinned at bind height, a walk
      // floats the feet by its hip-drop and a death clip leaves the corpse lying in MID-AIR at
      // standing hip height (the FBX curve carries the hips to ~0 as the body falls). Retarget
      // just the Y curve: world-space delta around the FBX hips REST, scaled by the rigs'
      // hip-height ratio, applied on top of the GLB hips bind. World-space math cancels FBX cm
      // units and armature-node transforms on both sides; X/Z stay dropped → clips remain
      // in place (Mixamo root motion never leaks into the preview).
      const posTrack = clip.tracks.find((t) => t.name === `${hipsName}.position`)
      let fbxHips: THREE.Object3D | null = null
      fbx.traverse((o) => {
        if ((o as THREE.Bone).isBone && o.name === hipsName && !fbxHips) fbxHips = o
      })
      let rootMotion: RootMotionProfile | null = null
      if (posTrack && fbxHips && glbHipsWorld && glbHipsParentInv) {
        fbx.updateMatrixWorld(true)
        const fh = fbxHips as THREE.Object3D
        const fbxHipsWorld = fh.getWorldPosition(new THREE.Vector3())
        const parentW = fh.parent?.matrixWorld ?? new THREE.Matrix4()
        const s = fbxHipsWorld.y > 1e-6 ? glbHipsWorld.y / fbxHipsWorld.y : 0
        if (s > 0) {
          const c = posTrack.clone() as THREE.VectorKeyframeTrack
          const v = c.values
          const p = new THREE.Vector3()
          // world-space horizontal path of the hips over the clip — feeds the root-motion
          // distance profile (foot motion inside a gait is NON-uniform; a character moved
          // at constant speed slips no matter how well the average rate is tuned)
          const worldXZ: { t: number; x: number; z: number }[] = []
          for (let i = 0; i + 2 < v.length; i += 3) {
            p.set(v[i], v[i + 1], v[i + 2]).applyMatrix4(parentW) // key → world (FBX space)
            worldXZ.push({ t: (c.times as unknown as Float32Array)[i / 3], x: p.x * s, z: p.z * s })
            const dy = (p.y - fbxHipsWorld.y) * s // height delta around rest, rig-scaled
            p.copy(glbHipsWorld)
            p.y += dy
            p.applyMatrix4(glbHipsParentInv) // world (GLB space) → hips-local track value
            v[i] = p.x
            v[i + 1] = p.y
            v[i + 2] = p.z
          }
          tracks.push(c)
          rootMotion = extractRootMotion(worldXZ)
        }
      }
      const merged = new THREE.AnimationClip(source.name, clip.duration, tracks)
      // forward-motion profile (GLB meters) for hosts that move the character in sync
      // with the gait: authored hips travel when the clip has it, else implied motion
      // derived from planted-foot sweep (in-place exports). Consumers pick which clips
      // to trust it on (locomotion clips — a flinch's "profile" is meaningless).
      const profile = rootMotion ?? extractFootRootMotion(scene, merged)
      if (profile) merged.userData.rootMotion = profile
      out.push(merged)
    } catch (e) {
      console.warn('anim merge failed:', source.name, e)
    }
  }
  return out
}

function extractRootMotion(worldXZ: { t: number; x: number; z: number }[]): RootMotionProfile | null {
  if (worldXZ.length < 3) return null
  const first = worldXZ[0]
  const last = worldXZ[worldXZ.length - 1]
  const nx = last.x - first.x
  const nz = last.z - first.z
  const net = Math.hypot(nx, nz)
  if (net < 0.15) return null // in-place clip — no authored travel
  const dx = nx / net
  const dz = nz / net
  const times: number[] = []
  const dist: number[] = []
  let maxSoFar = 0
  for (const k of worldXZ) {
    // clamp to monotonic: tiny backward hip shifts (weight rocking) are not "un-travel"
    maxSoFar = Math.max(maxSoFar, (k.x - first.x) * dx + (k.z - first.z) * dz)
    times.push(k.t)
    dist.push(maxSoFar)
  }
  return { times, dist, total: maxSoFar }
}

// In-place clips (no authored hips travel) still IMPLY ground motion: while a foot is
// PLANTED it sweeps backward under the body at exactly the speed the gait would cover
// ground. Sample the merged clip on the real skeleton and integrate that implied speed
// (max backward rate across feet, model faces +Z) into the same cumulative profile.
// The scene is the shared clone SOURCE — every bone's TRS is snapshotted and restored
// around sampling, or the pose leaks into every instance cloned later (the retargetClip
// corruption trap).
function extractFootRootMotion(scene: THREE.Object3D, clip: THREE.AnimationClip): RootMotionProfile | null {
  const feet: THREE.Object3D[] = []
  const bones: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[] = []
  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      bones.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() })
      if (/foot$/i.test(o.name)) feet.push(o)
    }
  })
  if (feet.length < 2) return null
  const mixer = new THREE.AnimationMixer(scene)
  const action = mixer.clipAction(clip)
  action.play()
  const K = 60
  const times: number[] = []
  const dist: number[] = []
  let prev: THREE.Vector3[] = []
  let acc = 0
  for (let k = 0; k <= K; k++) {
    const t = (k / K) * clip.duration * 0.999
    mixer.setTime(t)
    scene.updateMatrixWorld(true)
    const cur = feet.map((f) => f.getWorldPosition(new THREE.Vector3()))
    if (k > 0) {
      const dtI = (clip.duration * 0.999) / K
      let back = 0
      for (let i = 0; i < feet.length; i++) back = Math.max(back, (prev[i].z - cur[i].z) / dtI)
      acc += Math.max(0, back) * dtI
    }
    times.push(t)
    dist.push(acc)
    prev = cur
  }
  action.stop()
  mixer.uncacheRoot(scene)
  for (const b of bones) {
    b.o.position.copy(b.p)
    b.o.quaternion.copy(b.q)
    b.o.scale.copy(b.s)
  }
  scene.updateMatrixWorld(true)
  return acc >= 0.15 ? { times, dist, total: acc } : null
}

// Pre-multiply every keyframe of a quaternion track by a fixed correction.
function premultiplyTrack(track: THREE.QuaternionKeyframeTrack, corr: THREE.Quaternion): void {
  const q = new THREE.Quaternion()
  const v = track.values
  for (let i = 0; i + 3 < v.length; i += 4) {
    q.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(corr)
    v[i] = q.x
    v[i + 1] = q.y
    v[i + 2] = q.z
    v[i + 3] = q.w
  }
}
