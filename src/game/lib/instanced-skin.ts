import {
  AnimationClip,
  AnimationMixer,
  BufferGeometry,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Matrix4,
  NearestFilter,
  Object3D,
  RGBAFormat,
  SkinnedMesh,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial, type Node, type NodeBuilder } from 'three/webgpu'
import {
  attribute,
  bufferAttribute,
  int,
  ivec2,
  mat4,
  normalLocal,
  positionLocal,
  textureLoad,
  uniform,
  vec4,
} from 'three/tsl'

const FPS = 30 // pose sample rate; the shader snaps to whole frames, it does not interpolate
const MAX_ROWS = 8192 // webgpu's max texture dimension — 8192 rows is 4.5 minutes of animation

export type ClipRange = {
  row: number // first row in the bone texture
  frames: number
}

// one submesh of the model: a body part, whether or not it is ever meant to come off
export type SkinPart = {
  name: string
  geometry: BufferGeometry
  source: Material
  bindMatrix: Matrix4
  bindMatrixInverse: Matrix4
  bone: number // the bone this part hangs off, for finding where it is in a pose
  alive: InstancedBufferAttribute // per instance: 1 draws it, 0 collapses it to nothing
}

export type InstancedSkin = {
  meshes: InstancedMesh[]
  parts: SkinPart[]
  clips: Map<string, ClipRange>
  fps: number
  texture: DataTexture
  poses: Float32Array // the same matrices the texture holds, kept so the cpu can ask about a pose
  rest: Float32Array // each bone's rest world position, 3 floats apiece
  bones: number
  frames: InstancedBufferAttribute // per-instance bone-texture row; whoever animates writes it
  matrices: InstancedBufferAttribute // shared by every part — they are one body
  capacity: number
}

// a detached part: its own transform and its own frozen pose, drawn by the same shader
export type LimbInstance = {
  mesh: InstancedMesh
  frames: InstancedBufferAttribute
  matrices: InstancedBufferAttribute
  capacity: number
}

// a zero-scale instance collapses to a point and rasterizes nothing — what an unused slot holds
export const PARKED = new Matrix4().makeScale(0, 0, 0)

/*
Renders many copies of one skinned model as instances, posed on the gpu.

Every pose the model can ever hold is baked into a float texture once — one row per sampled frame,
four texels per bone — and each instance carries a single number saying which row it is in. That
is the whole runtime state: no mixer, no skeleton, no per-copy cpu work. The cost of an extra
enemy is one matrix and one float.

The price is that instances cannot blend between clips and snap to 30 fps. The player keeps a real
SkinnedMesh and a mixer for that reason.
*/
export const createInstancedSkin = (root: Object3D, capacity: number): InstancedSkin => {
  const sources: SkinnedMesh[] = []
  root.traverse((object) => {
    if ((object as SkinnedMesh).isSkinnedMesh) sources.push(object as SkinnedMesh)
  })
  if (!sources.length) throw new Error('createInstancedSkin: model has no skinned mesh')

  // bake-gltf lifts every skinned mesh to the scene root, so submeshes share one skeleton and
  // therefore one bone texture — they differ only in geometry and material
  const bake = bakePoses(root, sources[0], root.animations)

  const frames = new InstancedBufferAttribute(new Float32Array(capacity), 1)
  frames.setUsage(DynamicDrawUsage)

  // one transform buffer for all parts: they are pieces of the same body, so writing a zombie's
  // matrix four times would be four copies of the same number
  const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
  matrices.setUsage(DynamicDrawUsage)
  for (let slot = 0; slot < capacity; slot++) PARKED.toArray(matrices.array, slot * 16)

  const parts: SkinPart[] = sources.map((mesh) => ({
    name: mesh.name,
    geometry: mesh.geometry,
    source: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
    bindMatrix: mesh.bindMatrix,
    bindMatrixInverse: mesh.bindMatrixInverse,
    bone: dominantBone(mesh.geometry, bake.bones),
    alive: filled(capacity),
  }))

  const meshes = parts.map((part) => build(part, bake.texture, frames, part.alive, matrices, capacity))

  return { ...bake, meshes, parts, fps: FPS, capacity, frames, matrices }
}

/*
A second, independent set of instances of ONE part — a pool of severed hands.

It shares the model's bone texture and geometry and costs one more draw call. Each limb freezes
its row at the moment it came off, so it keeps the exact pose the hand was in, and carries its own
transform so it can tumble away from the body it belonged to.
*/
export const createLimbInstance = (skin: InstancedSkin, part: SkinPart, capacity: number): LimbInstance => {
  const frames = new InstancedBufferAttribute(new Float32Array(capacity), 1)
  frames.setUsage(DynamicDrawUsage)

  const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
  matrices.setUsage(DynamicDrawUsage)
  for (let slot = 0; slot < capacity; slot++) PARKED.toArray(matrices.array, slot * 16)

  const mesh = build(part, skin.texture, frames, filled(capacity), matrices, capacity)
  return { mesh, frames, matrices, capacity }
}

/*
Where a part sits in model space in a given pose.

The baked matrix is `boneWorld × boneInverse`, so applying it to the bone's REST world position
cancels the inverse and leaves the posed one. That is the pivot a severed limb spins around, and
the offset that places it exactly where the hand was.
*/
const pose = new Matrix4()

export const partPosition = (skin: InstancedSkin, row: number, bone: number, out: Vector3): Vector3 => {
  pose.fromArray(skin.poses, row * skin.bones * 16 + bone * 16)
  return out.fromArray(skin.rest, bone * 3).applyMatrix4(pose)
}

const filled = (capacity: number) => {
  const attribute = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1)
  attribute.setUsage(DynamicDrawUsage)
  return attribute
}

const build = (
  part: SkinPart,
  texture: DataTexture,
  frames: InstancedBufferAttribute,
  alive: InstancedBufferAttribute,
  matrices: InstancedBufferAttribute,
  capacity: number,
) => {
  const material = new InstancedSkinMaterial(
    part.source,
    texture,
    bufferAttribute<'float'>(frames, 'float').toInt(),
    bufferAttribute<'float'>(alive, 'float'),
    part.bindMatrix,
    part.bindMatrixInverse,
  )

  const mesh = new InstancedMesh(part.geometry, material, capacity)
  mesh.instanceMatrix = matrices
  // the base geometry's bounding sphere describes one enemy at the origin, not the crowd
  mesh.frustumCulled = false
  return mesh
}

/*
The bone a part hangs off: the one carrying the most skin weight across the whole submesh.

Read from the geometry rather than matched by name — a hand submesh is skinned overwhelmingly to
the hand bone whatever the rig calls it, and no naming convention has to survive the next model.
*/
const dominantBone = (geometry: BufferGeometry, bones: number): number => {
  const index = geometry.getAttribute('skinIndex')
  const weight = geometry.getAttribute('skinWeight')
  if (!index || !weight) return 0

  const total = new Float64Array(bones)
  for (let vertex = 0; vertex < index.count; vertex++) {
    total[index.getX(vertex)] += weight.getX(vertex)
    total[index.getY(vertex)] += weight.getY(vertex)
    total[index.getZ(vertex)] += weight.getZ(vertex)
    total[index.getW(vertex)] += weight.getW(vertex)
  }

  let best = 0
  for (let bone = 1; bone < bones; bone++) if (total[bone] > total[best]) best = bone
  return best
}

/*
Walks every clip with a mixer and copies the skeleton's bone matrices out frame by frame.

`Skeleton.boneMatrices` is already exactly what a skinning shader wants (bone world × inverse
bind), and its layout — 16 floats per bone, column major — is four RGBA texels per bone, so a
frame is one `set()` into the row. No repacking anywhere.
*/
const bakePoses = (root: Object3D, skinned: SkinnedMesh, clips: AnimationClip[]) => {
  const { skeleton } = skinned
  const bones = skeleton.bones.length
  const width = bones * 4
  const rows = clips.reduce((total, clip) => total + frameCount(clip), 0)
  if (rows > MAX_ROWS) throw new Error(`createInstancedSkin: ${rows} pose rows exceeds the ${MAX_ROWS} texture limit`)

  const poses = new Float32Array(width * 4 * rows)
  const ranges = new Map<string, ClipRange>()
  const mixer = new AnimationMixer(root)

  let row = 0
  for (const clip of clips) {
    const frames = frameCount(clip)
    ranges.set(clip.name, { row, frames })

    // back to bind pose first: a clip that animates only some bones would otherwise inherit the
    // previous clip's last pose on the rest
    skeleton.pose()

    const action = mixer.clipAction(clip)
    action.play()
    for (let frame = 0; frame < frames; frame++) {
      // setTime rather than accumulated update(): sampled from the clip's own timeline every
      // frame, so rounding cannot drift across a long clip
      mixer.setTime(frame / FPS)
      root.updateMatrixWorld(true)
      skeleton.update()
      poses.set(skeleton.boneMatrices!, (row + frame) * width * 4)
    }
    action.stop()
    mixer.uncacheAction(clip)

    row += frames
  }

  // each bone's rest world position, which is what a baked matrix has to be applied to
  const rest = new Float32Array(bones * 3)
  const world = new Matrix4()
  for (let bone = 0; bone < bones; bone++) {
    world.copy(skeleton.boneInverses[bone]).invert()
    rest[bone * 3] = world.elements[12]
    rest[bone * 3 + 1] = world.elements[13]
    rest[bone * 3 + 2] = world.elements[14]
  }

  // leave the source model as we found it — the loader hands the same object to everyone
  mixer.stopAllAction()
  skeleton.pose()
  root.updateMatrixWorld(true)

  const texture = new DataTexture(poses, width, rows, RGBAFormat, FloatType)
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true

  return { texture, poses, rest, bones, clips: ranges }
}

// a loop's last frame is the first one again, so the count excludes it — sampling t = f/FPS for
// f in [0, frames) covers the cycle exactly once
const frameCount = (clip: AnimationClip) => Math.max(1, Math.round(clip.duration * FPS))

/*
Poses the vertex from the bone texture before the base class applies the instance matrix.

`material.positionNode` cannot do this: NodeMaterial.setupPosition applies instancing FIRST and
then overwrites positionLocal with positionNode, so a skinned positionNode would throw the
instance transform away. Overriding setupPosition puts us where three's own `skinning()` runs.
*/
class InstancedSkinMaterial extends MeshStandardNodeMaterial {
  constructor(
    source: Material,
    private readonly bones: DataTexture,
    private readonly row: Node<'int'>,
    private readonly alive: Node<'float'>,
    private readonly bindMatrix: Matrix4,
    private readonly bindMatrixInverse: Matrix4,
  ) {
    super()
    this.copy(source as MeshStandardNodeMaterial)
  }

  setupPosition(builder: NodeBuilder) {
    const index = attribute<'uvec4'>('skinIndex', 'uvec4')
    const weight = attribute<'vec4'>('skinWeight', 'vec4')

    // four consecutive texels are the four columns of one bone's matrix, in mat4()'s own order
    const bone = (boneIndex: Node<'int'>) => {
      const column = boneIndex.mul(4)
      return mat4(
        textureLoad(this.bones, ivec2(column, this.row)),
        textureLoad(this.bones, ivec2(column.add(1), this.row)),
        textureLoad(this.bones, ivec2(column.add(2), this.row)),
        textureLoad(this.bones, ivec2(column.add(3), this.row)),
      )
    }

    const blended = bone(int(index.x))
      .mul(weight.x)
      .add(bone(int(index.y)).mul(weight.y))
      .add(bone(int(index.z)).mul(weight.z))
      .add(bone(int(index.w)).mul(weight.w))

    const skin = uniform(this.bindMatrixInverse).mul(blended).mul(uniform(this.bindMatrix))

    // a severed part multiplies out to the instance origin: every triangle degenerate, nothing
    // rasterized, no branch and no second draw call
    positionLocal.assign(skin.mul(vec4(positionLocal, 1)).xyz.mul(this.alive))
    normalLocal.assign(skin.transformDirection(normalLocal).xyz)

    return super.setupPosition(builder)
  }
}
