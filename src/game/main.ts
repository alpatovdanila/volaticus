// Empty scene. Everything from here is authored deliberately, class by class.
//
// What this file is allowed to be: the boot. A renderer, a scene, a camera, a loop.
// Nothing else lives here — the moment something has a second reason to change, it
// becomes its own module and gets wired in from here explicitly.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { scopeHmrReloads } from '../lib/hmr-scope'

// the dev server suppresses full reloads for src/** unless the page opts in
scopeHmrReloads(['src/game/', 'src/lib/', 'src/inventory/'])

const renderer = new WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0b0d10')

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200)
camera.position.set(0, 7.2, 5.2)
camera.lookAt(0, 0.9, -0.6)

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}
window.addEventListener('resize', resize)
resize()

async function start(): Promise<void> {
  await renderer.init()

  const timer = new THREE.Timer()
  timer.connect(document)

  const frame = (timestamp: number): void => {
    timer.update(timestamp) 
    const dt = timer.getDelta()
    void dt // nothing to advance yet
    renderer.render(scene, camera)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void start()
