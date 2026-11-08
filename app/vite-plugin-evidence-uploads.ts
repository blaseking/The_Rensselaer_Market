import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB
const UPLOAD_DIR = join(process.cwd(), 'uploads')

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

/** A tiny dev-only file store, bundled straight into the Vite dev server (no separate
 * process to run): evidence images live here, off-chain, with just a content-hash
 * filename stored on-chain as a reference. Not meant for production — it's local disk,
 * for a local demo. */
export function evidenceUploadsPlugin(): Plugin {
  return {
    name: 'evidence-uploads',
    configureServer(server) {
      if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true })

      server.middlewares.use('/api/evidence-upload', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }
        const url = new URL(req.url ?? '', 'http://localhost')
        const extRaw = url.searchParams.get('ext') ?? 'bin'
        const ext = /^[a-zA-Z0-9]{1,10}$/.test(extRaw) ? extRaw.toLowerCase() : 'bin'

        const chunks: Buffer[] = []
        let total = 0
        let tooLarge = false
        req.on('data', (chunk: Buffer) => {
          if (tooLarge) return
          total += chunk.length
          if (total > MAX_UPLOAD_BYTES) {
            tooLarge = true
            res.statusCode = 413
            res.end(`File too large (max ${MAX_UPLOAD_BYTES} bytes)`)
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          if (tooLarge) return
          const data = Buffer.concat(chunks)
          const hash = createHash('sha256').update(data).digest('hex')
          const filename = `${hash}.${ext}`
          const path = join(UPLOAD_DIR, filename)
          if (!existsSync(path)) writeFileSync(path, data)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ref: filename }))
        })
      })

      server.middlewares.use('/uploads', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0])
        if (!/^[a-f0-9]+\.[a-zA-Z0-9]{1,10}$/.test(name)) {
          next()
          return
        }
        const path = join(UPLOAD_DIR, name)
        if (!existsSync(path)) {
          res.statusCode = 404
          res.end('Not found')
          return
        }
        const ext = name.split('.').pop() ?? ''
        res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream')
        res.end(readFileSync(path))
      })
    },
  }
}
