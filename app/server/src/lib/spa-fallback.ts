/**
 * The last two handlers on the Express app (obj 901031).
 *
 * 1. Any request under `/api` that no router answered gets a JSON 404, for every
 *    method. Before this, an unknown GET fell through to the app-shell catch-all
 *    and came back `200 text/html`, so a typo'd or removed endpoint showed up as
 *    a JSON parse error (or a silent "ok") instead of a clear 404.
 * 2. Every other unmatched GET serves the single-page app shell (index.html),
 *    run through `render` so the first paint carries the install's branding.
 *
 * Must be mounted AFTER every API router and the static file handler.
 */
import fs from 'fs'
import path from 'path'
import type { Express, Request, Response } from 'express'

export function apiNotFound(req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found', method: req.method, path: req.originalUrl.split('?')[0] })
}

export function mountSpaFallback(app: Express, clientDist: string, render: (html: string) => string = h => h): void {
  app.use('/api', apiNotFound)
  app.get('*', (_req, res) => {
    fs.readFile(path.join(clientDist, 'index.html'), 'utf-8', (err, html) => {
      if (err) { res.status(404).send('Frontend not built'); return }
      res.setHeader('Cache-Control', 'no-cache')
      res.type('html').send(render(html))
    })
  })
}
