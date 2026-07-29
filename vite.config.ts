import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateArrowPlank,
  generatePlank,
  generatePost,
  generateRing,
  generateStar,
} from './src/editor/inventory/procgeom'

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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
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
            const rawName =
              String(body.name ?? 'upload.png')
                .replace(/\\/g, '/')
                .split('/')
                .pop() ?? 'upload.png'
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
          if (url.pathname.startsWith('/models/') && req.method === 'GET') {
            // Serve components files straight from disk. resources/models/** is EXCLUDED from the
            // vite watcher (so /__model/tune GLB writes don't full-reload the studio), but the
            // publicDir registry is watcher-fed — models added after boot would 404 through it.
            // This middleware bypasses the registry entirely: always fresh, no restart needed.
            const rel = decodeURIComponent(url.pathname.slice(1))
            const abs = safePath(RES_DIR, rel)
            if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return next()
            const types: Record<string, string> = {
              '.glb': 'components/gltf-binary',
              '.gltf': 'components/gltf+json',
              '.fbx': 'application/octet-stream',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
            }
            res.statusCode = 200
            res.setHeader('Content-Type', types[path.extname(abs).toLowerCase()] ?? 'application/octet-stream')
            res.end(fs.readFileSync(abs))
            return
          }
          if (url.pathname === '/__model/tune' && req.method === 'POST') {
            // Imported-GLB material tuning: patch metallicFactor/roughnessFactor of a named
            // glTF material INSIDE the .glb (the components file is the single source of truth for
            // its materials — no doc-side override). Rewrites only the JSON chunk; the binary
            // chunk (geometry/textures/animations) is copied through byte-for-byte.
            const body = await readBody(req)
            const rel = String(body.src ?? '')
            const abs = safePath(RES_DIR, rel)
            if (!abs || !rel.endsWith('.glb') || !fs.existsSync(abs)) return send(400, { error: 'bad src' })
            const glb = fs.readFileSync(abs)
            if (glb.readUInt32LE(0) !== 0x46546c67) return send(400, { error: 'not a GLB' })
            const chunks: { type: number; data: Buffer }[] = []
            for (let off = 12; off < glb.length;) {
              const clen = glb.readUInt32LE(off)
              const ctype = glb.readUInt32LE(off + 4)
              chunks.push({ type: ctype, data: glb.subarray(off + 8, off + 8 + clen) })
              off += 8 + clen
            }
            const jc = chunks.find((c) => c.type === 0x4e4f534a)
            if (!jc) return send(400, { error: 'no JSON chunk' })
            const g = JSON.parse(jc.data.toString('utf8'))
            const targets = (g.materials ?? []).filter(
              (m: { name?: string }) => body.material == null || m.name === body.material,
            )
            if (!targets.length) return send(404, { error: 'material not found' })
            const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
            for (const m of targets) {
              const p = (m.pbrMetallicRoughness ??= {})
              if (typeof body.metalness === 'number') p.metallicFactor = clamp01(body.metalness)
              if (typeof body.roughness === 'number') p.roughnessFactor = clamp01(body.roughness)
            }
            jc.data = Buffer.from(JSON.stringify(g), 'utf8')
            // reassemble with 4-byte chunk alignment (JSON pads with spaces, others with zeros)
            let total = 12
            for (const c of chunks) total += 8 + c.data.length + ((4 - (c.data.length % 4)) % 4)
            const out = Buffer.alloc(total)
            out.writeUInt32LE(0x46546c67, 0)
            out.writeUInt32LE(2, 4)
            out.writeUInt32LE(total, 8)
            let o = 12
            for (const c of chunks) {
              const pad = (4 - (c.data.length % 4)) % 4
              out.writeUInt32LE(c.data.length + pad, o)
              out.writeUInt32LE(c.type, o + 4)
              c.data.copy(out, o + 8)
              if (pad && c.type === 0x4e4f534a) out.fill(0x20, o + 8 + c.data.length, o + 8 + c.data.length + pad)
              o += 8 + c.data.length + pad
            }
            fs.writeFileSync(abs, out)
            return send(200, { ok: true })
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
            return send(400, {
              error:
                'type must be plank|post|ring|arrow|star; params: w/h/d(+tip for arrow) or radius(+Top/Bottom)/height/segments(+thickness for ring; +innerRatio/points/depth for star), craft, seed',
            })
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

// Guarded hot reload for the studio. Instead of vite's default JS full-reload
// broadcast, announce the changed file and let the page decide: main.ts calls
// scopeHmrReloads() from src/lib/hmr-scope.ts, which HOLDS the reload while there
// are unsaved slot edits (reload would nuke them) and otherwise reloads. CSS keeps
// vite's native hot swap (no reload at all).
function scopedReload(): Plugin {
  return {
    name: 'volaticus-scoped-reload',
    handleHotUpdate(ctx) {
      const rel = path.relative(ROOT, ctx.file).replace(/\\/g, '/')
      // src/**.ts drives the studio; inventory/**.json is runtime data (loaders re-fetch on
      // reload). Both go through the guarded reload path; everything else uses vite's default.
      const owned = (rel.startsWith('src/') && !rel.endsWith('.css')) || (rel.startsWith('inventory/') && rel.endsWith('.json'))
      if (!owned) return
      ctx.server.ws.send({ type: 'custom', event: 'volaticus:src-change', data: { file: rel } })
      return [] // suppress the global full-reload broadcast
    },
  }
}

/*
Everything the built game fetches at runtime rather than imports.

The game reads inventory items by url, and every item directory is self-contained — doc plus its
glb or ktx2 — so shipping a whole item type is a directory copy and nothing has to be traced. The
levels come along as loose files for the same reason they are fetched rather than imported: so a
level can be swapped on the server without a rebuild.

Also renames the html. The build's entry is game.html because index.html is the editor, which is
dev-only, but a static host wants an index — so the emitted page becomes one. Safe to rename in
place: `base: './'` means it refers to its assets relatively.
*/
function bundleAssets(): Plugin {
  return {
    name: 'volaticus-bundle-assets',
    apply: 'build',
    closeBundle() {
      const out = path.join(ROOT, 'dist')
      const copy = (from: string, to: string) => fs.cpSync(from, path.join(out, to), { recursive: true })

      copy(path.join(INV_DIR, 'items'), 'inventory/items')
      copy(path.join(ROOT, 'src/game/levels'), 'src/game/levels')

      fs.renameSync(path.join(out, 'game.html'), path.join(out, 'index.html'))
      // without this github pages runs jekyll over the output and drops anything it dislikes
      fs.writeFileSync(path.join(out, '.nojekyll'), '')
    },
  }
}

export default defineConfig(({ command }) => ({
  // relative, so the bundle works from a subpath (github pages serves it under /<repo>/) without
  // anyone having to write the repo name down. Runtime urls read import.meta.env.BASE_URL
  base: './',
  // 3.6GB of raw shelf that only the editor reads — the game's assets are all self-contained
  // inventory items, copied by bundleAssets instead
  publicDir: command === 'build' ? false : 'resources',
  // WebGPU migration: alias bare `three` to the WebGPU build (which bundles core +
  // WebGPURenderer + node materials) so the whole app shares ONE THREE instance.
  // Exact-match regex so `three/webgpu`, `three/tsl`, `three/addons/*` resolve normally.
  resolve: {
    alias: [
      { find: /^three$/, replacement: 'three/webgpu' },
      { find: '@engine', replacement: path.join(ROOT, 'src/game/engine') },
      { find: '@systems', replacement: path.join(ROOT, 'src/game/systems') },
      { find: '@components', replacement: path.join(ROOT, 'src/game/components') },
      { find: '@levels', replacement: path.join(ROOT, 'src/game/levels') },
      { find: '@lib', replacement: path.join(ROOT, 'src/game/lib') },
      { find: '@shared', replacement: path.join(ROOT, 'src/shared') },
      { find: '@inventory', replacement: INV_DIR },
    ],
  },
  plugins: [devApi(), scopedReload(), bundleAssets()],
  // don't full-reload the studio when a components file is rewritten (the /__model/tune endpoint
  // saves material tuning into the .glb while the user is dragging sliders)
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/resources/models/**'] } },
  build: {
    rollupOptions: {
      // the game, not the editor: index.html is the studio and it needs the dev-only /__inv api,
      // so there is nothing to gain from building it
      input: { game: path.join(ROOT, 'game.html') },
    },
  },
}))
