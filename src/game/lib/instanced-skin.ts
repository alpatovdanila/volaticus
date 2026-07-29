import {
  AnimationClip,
  AnimationMixer,
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

export type InstancedSkin = {
  meshes: InstancedMesh[]
  clips: Map<string, ClipRange>
  fps: number
  frames: InstancedBufferAttribute // per-instance bone-texture row; whoever animates writes it
  matrices: InstancedBufferAttribute // shared by every submesh
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
  const { texture, clips } = bakePoses(root, sources[0], root.animations)

  const frames = new InstancedBufferAttribute(new Float32Array(capacity), 1)
  frames.setUsage(DynamicDrawUsage)
  const row = bufferAttribute<'float'>(frames, 'float').toInt()

  // one transform buffer for all submeshes: they are parts of the same body, so writing a
  // zombie's matrix four times would be four copies of the same number
  const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
  matrices.setUsage(DynamicDrawUsage)
  for (let slot = 0; slot < capacity; slot++) PARKED.toArray(matrices.array, slot * 16)

  const meshes = sources.map((source) => {
    const material = new InstancedSkinMaterial(
      Array.isArray(source.material) ? source.material[0] : source.material,
      texture,
      row,
      source.bindMatrix,
      source.bindMatrixInverse,
    )

    const mesh = new InstancedMesh(source.geometry, material, capacity)
    mesh.instanceMatrix = matrices
    // the base geometry's bounding sphere describes one enemy at the origin, not the crowd
    mesh.frustumCulled = false
    return mesh
  })

  return { meshes, clips, fps: FPS, frames, matrices, capacity }
}

/*
Walks every clip with a mixer and copies the skeleton's bone matrices out frame by frame.

`Skeleton.boneMatrices` is already exactly what a skinning shader wants (bone world × inverse
bind), and its layout — 16 floats per bone, column major — is four RGBA texels per bone, so a
frame is one `set()` into the row. No repacking anywhere.
*/
const bakePoses = (root: Object3D, skinned: SkinnedMesh, clips: AnimationClip[]) => {
  const { skeleton } = skinned
  const width = skeleton.bones.length * 4
  const rows = clips.reduce((total, clip) => total + frameCount(clip), 0)
  if (rows > MAX_ROWS) throw new Error(`createInstancedSkin: ${rows} pose rows exceeds the ${MAX_ROWS} texture limit`)

  const data = new Float32Array(width * 4 * rows)
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
      data.set(skeleton.boneMatrices!, (row + frame) * width * 4)
    }
    action.stop()
    mixer.uncacheAction(clip)

    row += frames
  }

  // leave the source model as we found it — the loader hands the same object to everyone
  mixer.stopAllAction()
  skeleton.pose()
  root.updateMatrixWorld(true)

  const texture = new DataTexture(data, width, rows, RGBAFormat, FloatType)
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true

  return { texture, clips: ranges }
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

    positionLocal.assign(skin.mul(vec4(positionLocal, 1)).xyz)
    normalLocal.assign(skin.transformDirection(normalLocal).xyz)

    return super.setupPosition(builder)
  }
}
