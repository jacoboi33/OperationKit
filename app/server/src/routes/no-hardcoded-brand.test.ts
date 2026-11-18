/**
 * White-label guard for the server (obj 901037), the twin of the client's
 * app/client/src/lib/no-hardcoded-brand.test.ts. A string a route sends to the
 * page (an error, a message, an OAuth client name, an MCP title) must not name
 * the product: use the install's brand (resolveBrandName() in
 * services/branding-config.ts) or avoid naming it ("signed in to the app").
 * Comments are ignored, and test files are skipped (fixtures may use any name).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const ROUTES = path.join(SRC, 'routes')
// Service modules whose strings are returned to the page by a route.
const EXTRA_FILES = [path.join(SRC, 'services', 'user-google-connections.ts')]
const BRAND = /Operation\s?Kit|Command Center/

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.ts$/.test(e.name) && !/\.test\.|\.fixture\./.test(e.name) ? [p] : []
  })
}

/** Strip // and block comments so prose about the old name in comments doesn't count. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, '')) // keep line numbers
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

export function brandHits(rel: string, src: string): string[] {
  const hits: string[] = []
  stripComments(src).split('\n').forEach((line, i) => {
    if (BRAND.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
  })
  return hits
}

describe('no hardcoded brand in server response strings', () => {
  const files = [...walk(ROUTES), ...EXTRA_FILES]

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('has no literal product name in a route or a page-facing service', () => {
    const hits = files.flatMap(f => brandHits(path.relative(SRC, f), fs.readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })

  it('catches a hard-coded name in a response and ignores one in a comment', () => {
    expect(brandHits('x.ts', `res.status(403).json({ error: 'Only an admin signed in to Command Center can do this.' })`)).toHaveLength(1)
    expect(brandHits('x.ts', `res.json({ message: 'Welcome to Operation Kit' })`)).toHaveLength(1)
    expect(brandHits('x.ts', `// Command Center used to say this\n/* Operation Kit */\nres.json({ ok: true })`)).toEqual([])
  })
})
