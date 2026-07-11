import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateArrowPlank, generatePlank, generatePost, generateRing, generateStar } from './src/inventory/procgeom'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const INV_DIR = path.join(ROOT, 'inventory')
const RES_DIR = path.join(ROOT, 'resources')
const DEV_DIR = path.join(ROOT, '.dev')

function walkFiles(dir: string, ext: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(p, ext, base))
    else if (e.name.endsWith(ext)) out.push(path.relative(base, p).replace(/\\/g, '/'))
  }
  return out
}

// Resolve a client-supplied relative path safely inside a root dir.
function safePath(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel.replace(/\\/g, '/'))
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function devApi(): Plugin {
  let texCache: {
    at: number
    list: string[]
    animated: string[]
    sounds: string[]
    models: string[]
    packs: string[]
  } | null = null
  return {
    name: 'volaticus-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const send = (code: number, obj: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(obj))
        }
        try {
          if (url.pathname === '/__inv/list') {
            // *.geom.{i}.json (baked geometry) + *.variants.json (baked layouts) are
            // machine sidecars, not inventory items — the studio fetches them directly
            // by path (see loadBaked/loadVariants), so exclude them from the listing.
            const items = walkFiles(INV_DIR, '.json')
              .filter((p) => !/\.(geom\.\d+|variants)\.json$/.test(p))
              .map((p) => ({
                path: p,
                mtime: fs.statSync(path.join(INV_DIR, p)).mtimeMs,
              }))
            return send(200, { items })
          }
          if (url.pathname === '/__inv/read') {
            const abs = safePath(INV_DIR, url.searchParams.get('path') ?? '')
            if (!abs || !fs.existsSync(abs)) return send(404, { error: 'not found' })
            return send(200, {
              path: url.searchParams.get('path'),
              mtime: fs.statSync(abs).mtimeMs,
              content: fs.readFileSync(abs, 'utf8'),
            })
          }
          if (url.pathname === '/__inv/write' && req.method === 'POST') {
            const body = await readBody(req)
            const rel = String(body.path ?? '')
            const abs = safePath(INV_DIR, rel)
            if (!abs || !rel.endsWith('.json')) return send(400, { error: 'bad path' })
            const content = String(body.content ?? '')
            JSON.parse(content) // refuse to write broken JSON
            fs.mkdirSync(path.dirname(abs), { recursive: true })
            fs.writeFileSync(abs, content.endsWith('\n') ? content : content + '\n')
            return send(200, { ok: true, mtime: fs.statSync(abs).mtimeMs })
          }
          if (url.pathname === '/__inv/delete' && req.method === 'POST') {
            // #16: delete an inventory JSON file (materials clone trash etc.).
            // safePath-guarded to inventory/, .json only. Missing file = ok (idempotent).
            const body = await readBody(req)
            const rel = String(body.path ?? '')
            const abs = safePath(INV_DIR, rel)
            if (!abs || !rel.endsWith('.json')) return send(400, { error: 'bad path' })
            if (fs.existsSync(abs)) fs.rmSync(abs)
            return send(200, { ok: true })
          }
          if (url.pathname === '/__inv/upload' && req.method === 'POST') {
            // #29: save a user-supplied image (e.g. an alpha/holes mask) under
            // resources/user-textures/ and return its resources-relative path so
            // it can be referenced like any other texture (alpha mask etc.).
            const body = await readBody(req)
            const rawName = String(body.name ?? 'upload.png').replace(/\\/g, '/').split('/').pop() ?? 'upload.png'
            const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.+/, '.')
            const file = /\.(png|jpg|jpeg)$/i.test(safeName) ? safeName : safeName + '.png'
            const b64 = String(body.dataBase64 ?? '').replace(/^data:[^,]*,/, '')
            if (!b64) return send(400, { error: 'no data' })
            const dir = path.join(RES_DIR, 'user-textures')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, file), Buffer.from(b64, 'base64'))
            texCache = null // let /__textures re-index so the new file is listable
            return send(200, { ok: true, path: 'user-textures/' + file })
          }
          if (url.pathname === '/__textures') {
            if (!texCache || Date.now() - texCache.at > 5000)
              texCache = {
                at: Date.now(),
                // .png = minecraft packs + legacy slots; .jpg = a few freestylized catalog
                // maps; .ktx2 = the compressed PBR catalog (UI thumbnails read PNG siblings)
                list: [...walkFiles(RES_DIR, '.png'), ...walkFiles(RES_DIR, '.jpg'), ...walkFiles(RES_DIR, '.ktx2')],
                animated: walkFiles(RES_DIR, '.png.mcmeta').map((p) => p.replace(/\.mcmeta$/, '')),
                sounds: [...walkFiles(RES_DIR, '.wav'), ...walkFiles(RES_DIR, '.ogg'), ...walkFiles(RES_DIR, '.mp3')],
                models: [...walkFiles(RES_DIR, '.fbx'), ...walkFiles(RES_DIR, '.glb')],
                packs: fs
                  .readdirSync(RES_DIR, { withFileTypes: true })
                  .filter((e) => e.isDirectory() && fs.existsSync(path.join(RES_DIR, e.name, 'textures', 'block')))
                  .map((e) => e.name),
              }
            return send(200, {
              textures: texCache.list,
              animated: texCache.animated,
              sounds: texCache.sounds,
              models: texCache.models,
              packs: texCache.packs,
            })
          }
          if (url.pathname === '/__materials') {
            // Convenience catalog + thumbnail feed for the editor. Reads every
            // inventory/materials/*.json and attaches its color-map URL per
            // material for picker thumbs. File IO otherwise goes through /__inv
            // (materials live under inventory/).
            const matDir = path.join(INV_DIR, 'materials')
            const materials: unknown[] = []
            if (fs.existsSync(matDir)) {
              for (const f of fs.readdirSync(matDir).sort()) {
                if (!f.endsWith('.json')) continue
                let doc: any
                try {
                  doc = JSON.parse(fs.readFileSync(path.join(matDir, f), 'utf8'))
                } catch {
                  continue
                }
                const color = doc?.maps?.color ?? null
                materials.push({ doc, thumb: color ? '/' + color : null })
              }
            }
            return send(200, { materials })
          }
          if (url.pathname === '/__geom') {
            // procedural wood geometry service (same generator the factory uses)
            const q = url.searchParams
            const num = (k: string, dflt: number) => {
              const v = parseFloat(q.get(k) ?? '')
              return Number.isFinite(v) ? v : dflt
            }
            const craft = num('craft', 0.5)
            const geomSeed = Math.trunc(num('seed', 1))
            const type = q.get('type')
            if (type === 'plank')
              return send(200, generatePlank(num('w', 1), num('h', 0.12), num('d', 0.2), craft, geomSeed))
            if (type === 'post')
              return send(
                200,
                generatePost(
                  num('radiusTop', num('radius', 0.08)),
                  num('radiusBottom', num('radius', 0.08)),
                  num('height', 1),
                  Math.trunc(num('segments', 7)),
                  craft,
                  geomSeed,
                ),
              )
            if (type === 'ring')
              return send(
                200,
                generateRing(
                  num('radiusTop', num('radius', 0.3)),
                  num('radiusBottom', num('radius', 0.3)),
                  num('height', 0.12),
                  num('thickness', 0.02),
                  Math.trunc(num('segments', 12)),
                  craft,
                  geomSeed,
                ),
              )
            if (type === 'arrow')
              return send(
                200,
                generateArrowPlank(
                  num('w', 1),
                  num('h', 0.26),
                  num('d', 0.06),
                  craft,
                  geomSeed,
                  q.get('tip') != null ? num('tip', 0.2) : undefined,
                ),
              )
            if (type === 'star')
              return send(
                200,
                generateStar(
                  num('radius', 0.3),
                  num('innerRatio', 0.45),
                  Math.trunc(num('points', 5)),
                  num('depth', num('radius', 0.3) * 0.35),
                  craft,
                  geomSeed,
                ),
              )
            return send(400, { error: 'type must be plank|post|ring|arrow|star; params: w/h/d(+tip for arrow) or radius(+Top/Bottom)/height/segments(+thickness for ring; +innerRatio/points/depth for star), craft, seed' })
          }
          if (url.pathname === '/__shot' && req.method === 'POST') {
            const body = await readBody(req)
            const name = String(body.name ?? 'shot').replace(/[^a-z0-9_-]/gi, '_')
            const m = /^data:image\/png;base64,(.+)$/.exec(String(body.dataUrl ?? ''))
            if (!m) return send(400, { error: 'bad dataUrl' })
            fs.mkdirSync(DEV_DIR, { recursive: true })
            const file = path.join(DEV_DIR, name + '.png')
            fs.writeFileSync(file, Buffer.from(m[1], 'base64'))
            return send(200, { ok: true, file })
          }
        } catch (e) {
          return send(500, { error: String(e) })
        }
        next()
      })
    },
  }
}

// Page-scoped hot reload. Vite broadcasts JS-caused full reloads to EVERY
// connected client, so editing level-editor code used to reload the inventory
// studio (and could nuke unsaved slot work there) and vice versa. Instead of
// the default broadcast we announce the changed file and let each page decide:
// entries call scopeHmrReloads() from src/lib/hmr-scope.ts with the src/
// prefixes that can affect them. A page that has NOT registered the handler
// simply stops auto-reloading on TS edits (manual F5) — fail-quiet, never
// cross-reloads. CSS keeps vite's native hot swap (no reload at all).
function scopedReload(): Plugin {
  return {
    name: 'volaticus-scoped-reload',
    handleHotUpdate(ctx) {
      const rel = path.relative(ROOT, ctx.file).replace(/\\/g, '/')
      // levels/<id>/scripts/*.js enter the module graph via the game's dynamic
      // import — without this they too would full-reload every open page.
      const scoped = rel.startsWith('src/') || rel.startsWith('levels/')
      if (!scoped || rel.endsWith('.css')) return // default vite handling
      ctx.server.ws.send({ type: 'custom', event: 'volaticus:src-change', data: { file: rel } })
      return [] // suppress the global full-reload broadcast
    },
  }
}

export default defineConfig({
  publicDir: 'resources', // texture ids map 1:1 to URLs: vanilla/textures/... -> /vanilla/textures/...
  // WebGPU migration: alias bare `three` to the WebGPU build (which bundles core +
  // WebGPURenderer + node materials) so the whole app shares ONE THREE instance.
  // Exact-match regex so `three/webgpu`, `three/tsl`, `three/addons/*` resolve normally.
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  plugins: [devApi(), scopedReload()],
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: path.join(ROOT, 'index.html'),
      },
    },
  },
})
