/**
 * Browser-free checks (card #901024). These use Playwright's request client
 * only, so they run on a machine with no Chromium (for example a card sandbox)
 * and prove the scratch server and the seed are sound before the page tests.
 * They do not depend on theme or width, so playwright.config.ts runs this file
 * in the light-desktop project only.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { test, seed, ADMIN, PASS, BRAND, BOT } from './helpers'

async function signIn(request: APIRequestContext, user: string) {
  const r = await request.post('/api/auth/login', { data: { username: user, password: PASS } })
  expect(r.status(), `login as ${user}`).toBe(200)
}

test('api: the seed is in place (cards in every state, bot, workflow, notifications)', async ({ request }) => {
  await signIn(request, ADMIN)
  const cards = await (await request.get('/api/objectives')).json() as Array<{ id: number; status: string; ai_review_verdict: string | null }>
  const state = (id: number) => { const c = cards.find(x => x.id === id); return c ? `${c.status}:${c.ai_review_verdict ?? '-'}` : 'missing' }
  expect({
    queue: state(seed().cards.queue), working: state(seed().cards.working), aiReview: state(seed().cards.aiReview),
    reviewPass: state(seed().cards.reviewPass), reviewFail: state(seed().cards.reviewFail), reviewBlocked: state(seed().cards.reviewBlocked),
  }).toEqual({ queue: 'queue:-', working: 'working:-', aiReview: 'ai_review:-', reviewPass: 'review:pass', reviewFail: 'review:fail', reviewBlocked: 'review:blocked' })
  const bots = await (await request.get('/api/agent-chat/agents')).json() as { agents: Array<{ slug: string }> }
  expect(bots.agents.map(a => a.slug)).toContain(BOT.slug)
  const flows = await (await request.get(`/api/flows?workspace=${seed().workspace}`)).json() as { flows: Array<{ slug: string }> }
  expect(flows.flows.map(f => f.slug)).toContain('e2e-flow')
  const alerts = await (await request.get('/api/alerts')).json() as { alerts: Array<{ title: string }> }
  expect(alerts.alerts.length).toBeGreaterThanOrEqual(3)
})

test('api: the custom brand name is served', async ({ request }) => {
  const branding = await (await request.get('/api/branding')).json() as { name: string }
  expect(branding.name).toBe(BRAND)
  expect(await (await request.get('/')).text()).toContain(`<title>${BRAND}`)
})

test('api: sending the same chat message twice stores it once', async ({ request }) => {
  await signIn(request, ADMIN)
  const text = `api duplicate ${Date.now()}`
  const data = { text, client_msg_id: `api-dup-${Date.now()}` }
  const first = await request.post(`/api/agent-chat/agents/${BOT.slug}/messages`, { data })
  const second = await request.post(`/api/agent-chat/agents/${BOT.slug}/messages`, { data })
  expect(first.status()).toBeLessThan(300)
  expect(second.status()).toBeLessThan(300)
  const history = await (await request.get(`/api/agent-chat/agents/${BOT.slug}/messages`)).json() as { messages: Array<{ role: string; content: string }> }
  expect(history.messages.filter(m => m.role === 'user' && m.content === text)).toHaveLength(1)
})

test('api: signed-out calls get 401 JSON', async ({ request }) => {
  for (const url of ['/api/objectives', '/api/auth/me', '/api/admin/seats']) {
    const r = await request.get(url)
    expect(r.status(), url).toBe(401)
    expect(r.headers()['content-type'] || '', url).toContain('application/json')
  }
})

test('api: a member is refused admin routes, other workspaces and bot access changes', async ({ request }) => {
  await signIn(request, seed().member)
  expect((await request.get('/api/admin/seats')).status()).toBe(403)
  expect((await request.get('/api/admin/workspaces')).status()).toBe(403)
  expect((await request.get(`/api/objectives/${seed().cards.private}`)).status()).toBe(403)
  expect((await request.put(`/api/agent-chat/agents/${BOT.slug}/full-access/${seed().workspace}`, { data: { enabled: true } })).status()).toBe(403)
})

test('api: a card that does not exist is a JSON 404', async ({ request }) => {
  await signIn(request, ADMIN)
  const r = await request.get('/api/objectives/99999999')
  expect(r.status()).toBe(404)
  expect(await r.json()).toHaveProperty('error')
})

// Fixed by card #901031: unknown /api paths are a JSON 404, not the app shell
// (app/server/src/lib/spa-fallback.ts).
test('api: unknown /api path returns a JSON 404', async ({ request }) => {
  const r = await request.get('/api/does-not-exist-e2e')
  expect(r.status()).toBe(404)
  expect(r.headers()['content-type'] || '').toContain('application/json')
})

// Known bug, fix card #901033: built-in bots carry the vendor name whatever the
// brand is. Remove test.fail when that card ships.
test('api: bot names and descriptions carry no vendor name under a custom brand', async ({ request }) => {
  test.fail(true, 'Known bug — fix card #901033 (built-in bot "Operation Kit Dev", author "Operation Kit")')
  await signIn(request, ADMIN)
  const body = await (await request.get('/api/agent-chat/agents')).text()
  expect(body).not.toMatch(/Operation Kit/)
})

// Fresh install (card #901202): no legacy workspaces.json and no layer-graph
// generator. Both calls answer 200 with an empty result, so the pages that make
// them on load (Settings > Workspaces, Bots & skills) log no failed request.
test('api: fresh install — the legacy workspaces config answers with an empty list, not a 404', async ({ request }) => {
  await signIn(request, ADMIN)
  const res = await request.get('/api/workspaces-config')
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ workspaces: {} })
})
test('api: fresh install — the skill graph answers with an empty graph marked not set up', async ({ request }) => {
  await signIn(request, ADMIN)
  const res = await request.get('/api/admin/skill-graph')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('not_set_up')
  expect(body.reason).toMatch(/not set up/)
  expect(body.counts.agents).toBe(0)
})
