import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mountSpaFallback } from './spa-fallback.js'

// obj 901031: unknown /api paths used to fall through to the SPA catch-all and
// answer 200 text/html. They must be a JSON 404 for every method, while app
// paths keep serving the shell.
describe('mountSpaFallback', () => {
  let server: Server
  let base: string
  let dir: string

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-fallback-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><title>SHELL</title></html>')
    const app = express()
    app.get('/api/known', (_req, res) => { res.json({ ok: true }) })
    app.use(express.static(dir, { index: false }))
    mountSpaFallback(app, dir, html => html.replace('SHELL', 'BRANDED'))
    server = app.listen(0)
    await new Promise<void>(r => server.once('listening', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a registered /api route still answers', async () => {
    const r = await fetch(`${base}/api/known`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`unknown /api path is a JSON 404 for ${method}`, async () => {
      const r = await fetch(`${base}/api/does-not-exist?x=1`, { method })
      expect(r.status).toBe(404)
      expect(r.headers.get('content-type')).toContain('application/json')
      const body = await r.json()
      expect(body.error).toBe('Not found')
      expect(body.path).toBe('/api/does-not-exist')
    })
  }

  it('the bare /api path and nested unknown paths are JSON 404s too', async () => {
    for (const p of ['/api', '/api/', '/api/notifications', '/api/workflows/1/x']) {
      const r = await fetch(`${base}${p}`)
      expect(r.status, p).toBe(404)
      expect(r.headers.get('content-type'), p).toContain('application/json')
    }
  })

  it('non-API paths still serve the branded app shell', async () => {
    for (const p of ['/', '/o/123', '/settings/secrets', '/apix', '/api-docs']) {
      const r = await fetch(`${base}${p}`)
      expect(r.status, p).toBe(200)
      expect(r.headers.get('content-type'), p).toContain('text/html')
      expect(await r.text(), p).toContain('BRANDED')
    }
  })
})
