import { Router, type Response } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import {
  ChatBusyError,
  ChatUnavailableError,
  CLIENT_MSG_ID_RE,
  clearChat,
  findAgent,
  installDefaultProvider,
  isDemoOn,
  listAgents,
  listMessages,
  drainLaneQueue,
  laneTurnState,
  stopTurn,
  submitMessage,
  seedDemoKnowledge,
  setSetting,
  type ChatMessageRow,
} from '../services/agent-chat/engine.js'
import { CHAT_PROVIDERS, type ChatAgent } from '../services/agent-chat/agent-defs.js'
import { availableProviders, chooseProviderId, DEFAULT_MODELS, resolveModel } from '../services/agent-chat/providers.js'
import { effectiveTools, visibleCardStatuses } from '../services/agent-chat/tools.js'
import { TOOL_CATALOG } from '../services/agent-chat/tool-names.js'
import { webSearchStatus } from '../services/agent-chat/web-tools.js'
import { BotConfigError, clearBotConfig, hasAllTools, setBotConfig } from '../services/agent-chat/bot-config.js'
import { listEnabledModels } from '../services/model-registry.js'
import { aboutForAgents, ensureAboutFresh, getStoredAbout, queueAboutRefresh, resolveAbout, type BotAbout } from '../services/agent-chat/bot-about.js'
import { redactForStorage } from '../services/secret-redaction.js'
import {
  allHighAgency,
  HIGH_AGENCY_LEVELS,
  HighAgencyError,
  highAgencyView,
  MAX_NEW_PROJECTS_PER_WAKE,
  reconcileHighAgencyAccess,
  resyncHighAgencyFor,
  setHighAgency,
  wakeNow,
  workspaceOptions,
} from '../services/agent-chat/high-agency.js'
import {
  getDraft,
  listDrafts,
  resolveDelivery,
  setDraftStatus,
  type DraftRow,
  type EmailDraft,
  type EventDraft,
} from '../services/agent-chat/connectors.js'
import { getDb } from '../db/index.js'
import {
  allBotWorkspaceAccess,
  BotWorkspaceError,
  getBotWorkspaceAccess,
  grantBotWorkspace,
  revokeBotWorkspace,
  setBotWorkspaces,
  type BotWorkspaceAccess,
} from '../services/agent-chat/bot-workspaces.js'
import { listWorkspaces } from '../services/workspaces.js'
import fullAccessRouter, { fullAccessSummaries } from './agent-chat-full-access.js'
import { dropFullAccessForRevokedWorkspaces } from '../services/agent-chat/bot-full-access.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { logActivity } from './feed.js'
import { getAttachment, ImageRejected, parseIncomingImages, type IncomingImage } from '../services/agent-chat/attachments.js'
import { getSandboxScreenshot } from '../services/agent-chat/sandbox-screenshots.js'
import {
  createThread,
  deleteThread,
  listThreads,
  maxThreadsPerBot,
  resolveLane,
  ThreadRejected,
  updateThread,
  type ChatLane,
} from '../services/agent-chat/threads.js'
import { BotDeleteRefused, deleteBotFolder } from '../services/agent-chat/bot-delete.js'
import sidebarRouter from './agent-chat-sidebar.js'
import delegationsRouter from './agent-chat-delegations.js'
import botMessagesRouter from './agent-chat-bot-messages.js'
import botWorkRouter from './agent-chat-bot-work.js'
import { markFeedMessage } from '../services/agent-chat/bot-attention.js'
import { resolveNeedsYouMessages } from '../services/decision-queue.js'
import { isHighAgencyActivityCard } from '../services/agent-chat/high-agency-cards.js'
import { CARD_WAKES_THREAD_TITLE, cardWakesGloballyEnabled, getCardWakeSwitch, setCardWakeSwitch } from '../services/agent-chat/card-wake-routing.js'

/**
 * Built-in agent chat (obj 719987) — /api/agent-chat
 *
 *   GET    /agents                     agents on this install (+ load problems for admins)
 *   GET    /agents/:slug               one agent's definition (also read by the MCP connector)
 *   GET    /agents/:slug/messages      the caller's ongoing chat with that agent
 *   POST   /agents/:slug/messages      send a message, run the turn, return the new rows
 *   DELETE /agents/:slug/messages      clear the caller's chat with that agent
 *   GET    /agents/:slug/threads       the caller's side threads with that agent
 *   POST   /agents/:slug/threads       open a new side thread (a concurrent task lane)
 *   PATCH  /agents/:slug/threads/:id   rename / pin / archive (= close) a side thread
 *   DELETE /agents/:slug/threads/:id   delete a side thread and its messages
 *   GET    /attachments/:id            one image the caller attached (owner only)
 *   PUT    /drafts/:id                 edit a draft before sending
 *   POST   /drafts/:id/send            the person's Send / Add to calendar click
 *   POST   /drafts/:id/discard
 *   PUT    /settings                   admin: demo on/off, install default provider
 *   PUT    /agents/:slug/config        admin: this bot's default model / provider / tools / all tools (obj 900671)
 *   DELETE /agents/:slug/config        admin: reset the bot to exactly what its agent file says
 *   GET    /agents/:slug/high-agency   this bot's High Agency setting, wake times and last wake (obj 900748)
 *   PUT    /agents/:slug/high-agency   admin: High Agency on/off, level 1-10 (obj 900794), workspace, permissions
 *   POST   /agents/:slug/high-agency/wake  admin: one wake now (works while off, to try it)
 *   GET    /agents/:slug/card-wakes    needs_agent card wakes: on/off (default on) + recent wakes (obj 901328)
 *   PUT    /agents/:slug/card-wakes    admin: {enabled} — turn this bot's card wakes off / back on
 *   GET    /agents/:slug/workspaces    the bot's workspace access list (obj 900797)
 *   PUT    /agents/:slug/workspaces    admin: set the whole list (restricts the bot)
 *   POST   /agents/:slug/workspaces    admin: grant one workspace
 *   DELETE /agents/:slug/workspaces/:workspace  admin: revoke one workspace
 *   DELETE /agents/:slug               admin: delete a bot — its agent folder moves to .deleted/ (obj 900798)
 *   GET    /bot-conversations          bot-to-bot threads the caller may see (obj 900859,
 *                                      routes/agent-chat-bot-messages.ts)
 *   GET    /bot-conversations/:id      one bot-to-bot thread, every entry on it
 *   /sidebar/*                         the caller's own Bots sidebar: pins, sections, unread (obj 900798,
 *                                      routes/agent-chat-sidebar.ts)
 *
 * WORKSPACE ACCESS (obj 900797). Bots stay global — one definition for the
 * install. Each bot carries a list of the workspaces it may read, write and be
 * woken in (services/agent-chat/bot-workspaces.ts); the chat tools, High Agency
 * and High Agency's filed cards enforce it. Grant/revoke is a signed-in admin's
 * click only — never an API key, so a bot cannot widen its own reach.
 *
 * RENAME (obj 900798). PUT /agents/:slug/config also takes `name`: an admin's
 * display name for the bot, for everyone (slug, URL and file unchanged; null
 * or "" = the file's name). Every agent carries `file_name` beside `name`.
 *
 * ABOUT (obj 900747). Every agent carries `about`: the description, how-to and
 * example prompts the "i" panel shows, with the file's own text winning and
 * generated text filling the rest (services/agent-chat/bot-about.ts). A list
 * read queues a background refresh for any bot whose cached About no longer
 * matches it, and a settings change queues one straight away. GET /agents/:slug
 * also carries `instructions`: the system prompt the panel shows READ-ONLY,
 * with high-confidence secret shapes masked. Nothing here edits a prompt.
 *
 * Every chat is strictly per person: a caller only ever reads or writes their
 * own messages and drafts. Sending a draft needs a signed-in browser session —
 * an API key (a bot, another agent) can never press Send.
 *
 * SIDE THREADS (obj 900370). The three /messages routes take an optional
 * `thread_id` — query string on GET/DELETE, body field on POST. Omitting it
 * means the MAIN conversation, which is why every existing caller is unaffected.
 * `resolveLane` is the single gate: a `thread_id` that is not the caller's own,
 * or belongs to a different bot, 404s rather than quietly falling back to the
 * main conversation (a silent fallback would write a side-thread message into
 * the main history, which is exactly the leak this feature must not have).
 */
const router: Router = Router()
router.use(requireAuth)
router.use('/sidebar', sidebarRouter)
// obj 900839: "Approve on my behalf" grants — owner-only writes, see the file.
router.use(delegationsRouter)
// obj 900859: bot-to-bot threads, read-only for people — see the file.
router.use(botMessagesRouter)
// obj 900972: per-workspace Full access — admin-browser-only writes, see the file.
router.use(fullAccessRouter)
// obj 900947: per-bot Work tab, High Agency Activity feed, sidebar live line — read-only.
router.use(botWorkRouter)

/** What the bot list shows about a bot's workspace access; workspace names only where the caller may see them. */
interface WorkspaceAccessSummary { mode: 'restricted' | 'unrestricted'; workspaces: string[]; count: number }

function workspaceAccessSummary(req: AuthRequest, a: Pick<BotWorkspaceAccess, 'mode' | 'workspaces'>): WorkspaceAccessSummary {
  const visible = callerWorkspaceFilter(req)
  const workspaces = visible ? a.workspaces.filter(w => visible.has(w)) : a.workspaces
  // A member gets the count of what they can see only, so no hint of other workspaces.
  return { mode: a.mode, workspaces, count: workspaces.length }
}

/** null = the caller sees every workspace (admin); else the slugs they belong to. */
function callerWorkspaceFilter(req: AuthRequest): Set<string> | null {
  if (req.user?.role === 'admin') return null
  return new Set(getUserWorkspaces(req.user!.id).map(w => w.workspace))
}

function publicAgent(a: ChatAgent, withPrompt = false, about?: BotAbout, access?: WorkspaceAccessSummary) {
  return {
    slug: a.slug,
    name: a.name,
    // obj 900798: the file's own name, which differs from `name` once an admin renames the bot.
    file_name: a.file_name ?? a.name,
    description: a.description,
    avatar: a.avatar,
    colour: a.colour,
    knowledge_folders: a.knowledge_folders,
    tools: a.tools,
    model: a.model,
    provider: a.provider,
    version: a.version,
    author: a.author,
    how_to_use: a.how_to_use,
    example_prompts: a.example_prompts,
    source: a.source,
    // obj 900671: what the bot can actually call, and where each setting comes from.
    all_tools: hasAllTools(a),
    effective_tools: effectiveTools(a),
    file_defaults: a.file_defaults ?? { provider: a.provider, model: a.model, tools: a.tools },
    config: a.config
      ? { name: a.config.name, provider: a.config.provider, model: a.config.model, tools: a.config.tools, all_tools: a.config.all_tools, updated_by: a.config.updated_by, updated_at: a.config.updated_at }
      : null,
    // obj 900747: the resolved About (file text first, generated text for the rest).
    about: about ?? resolveAbout(a, getStoredAbout(a.slug)),
    // obj 900797: where this bot may work (set on the list route; see workspaceAccessSummary).
    ...(access ? { workspace_access: access } : {}),
    ...(withPrompt
      ? { system_prompt: a.system_prompt, schedules: a.schedules, instructions: redactForStorage(a.system_prompt).text }
      : {}),
  }
}

/** One agent for a response, after queueing an About refresh if its definition changed. */
function agentResponse(a: ChatAgent, opts: { force?: boolean; reason?: string } = {}) {
  try {
    queueAboutRefresh(a, opts)
  } catch (err) {
    console.warn('[agent-chat] About refresh not queued:', err instanceof Error ? err.message : err)
  }
  return { ...publicAgent(a, true), answered_by: providerFor(a) }
}

function providerFor(a: ChatAgent) {
  const id = chooseProviderId(a, installDefaultProvider())
  return { id, model: resolveModel(id, a) || null }
}

/**
 * Model ids the bot page offers per provider (obj 900671). Suggestions only:
 * the field is free text, because a provider ships models faster than this
 * list. Claude ids come from the install's own model registry (Settings →
 * Models), so a model switched off there is not suggested here.
 */
function modelSuggestions(): Record<string, string[]> {
  let registry: { id: string; engine: string }[] = []
  try { registry = listEnabledModels() } catch { /* no registry table → defaults only */ }
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
  const claude = uniq([...registry.filter(m => m.engine === 'claude').map(m => m.id), DEFAULT_MODELS.claude])
  return {
    claude,
    anthropic: claude,
    openai: uniq([DEFAULT_MODELS.openai]),
    xai: uniq([...registry.filter(m => m.engine === 'grok').map(m => m.id), DEFAULT_MODELS.xai]),
    'openai-compatible': [],
    demo: [DEFAULT_MODELS.demo],
  }
}

/** The enabled registry rows (Settings → Models); none before the table exists. */
function enabledModelsOrEmpty() {
  try { return listEnabledModels() } catch { return [] }
}

/** Only a signed-in admin may change what a bot runs on — never an API key (a bot must not grant itself tools). */
function adminSessionOr403(req: AuthRequest, res: Response): boolean {
  if (req.user?.role !== 'admin' || req.authVia !== 'session') {
    res.status(403).json({ error: 'Only an admin signed in to the app in the browser can change a bot\'s settings (model, tools, workspace access, High Agency).' })
    return false
  }
  return true
}

/**
 * obj 900947: High Agency activity moved to the bot's Activity feed. Messages
 * already in a chat are NEVER rewritten or deleted; at read time a message about
 * High Agency activity (not a needs-you post) is flagged `activity_feed` so the
 * UI collapses it. The stored row is untouched.
 */
function markActivityMessages(messages: ChatMessageRow[]): ChatMessageRow[] {
  const db = getDb()
  const memo = new Map<number, boolean>()
  const isHa = (id: number) => {
    if (!memo.has(id)) memo.set(id, isHighAgencyActivityCard(db, id))
    return memo.get(id)!
  }
  const marked = messages.map(m => {
    if (m.role !== 'assistant') return m
    const meta = (m.meta ?? null) as Record<string, unknown> | null
    if (!markFeedMessage(meta, m.content ?? '', isHa)) return m
    return { ...m, meta: { ...(meta ?? {}), activity_feed: true } } as ChatMessageRow
  })
  // obj 901084: a needs-you post whose card ended (or whose decision was cleared)
  // is marked resolved, so it renders as one line with no dead buttons; a decision
  // post with no decision id is linked to the card's open one.
  try {
    return resolveNeedsYouMessages(db, marked as (ChatMessageRow & { meta?: Record<string, unknown> | null })[]) as ChatMessageRow[]
  } catch (err) {
    console.warn('[agent-chat] needs-you resolution failed:', err instanceof Error ? err.message : String(err))
    return marked
  }
}

/** Drafts + card statuses referenced by these messages, so the UI can render them. */
function attachments(userId: number, slug: string, messages: ChatMessageRow[]) {
  const draftIds = new Set(messages.map(m => m.meta?.draft_id).filter((x): x is number => typeof x === 'number'))
  const cardIds = [...new Set(messages.map(m => m.meta?.objective_id).filter((x): x is number => typeof x === 'number'))]
  const drafts = listDrafts(userId, slug).filter(d => draftIds.has(d.id))
  const cards = visibleCardStatuses(userId, cardIds, slug)
  return { drafts, cards }
}

function agentOr404(req: AuthRequest, res: Response): ChatAgent | null {
  const a = findAgent(String(req.params.slug))
  if (!a) res.status(404).json({ error: `No agent "${req.params.slug}" on this install` })
  return a
}

/** A ThreadRejected carries its own status; anything else is a real 500. */
function threadError(res: Response, err: unknown): void {
  if (err instanceof ThreadRejected) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error('[agent-chat] side thread failed:', err instanceof Error ? err.message : err)
  res.status(500).json({ error: 'That did not work. Try again.' })
}

/**
 * Which conversation this request means. Returns null AFTER answering, so a
 * caller can `if (!lane) return` the same way it does for agentOr404.
 */
function laneOr404(req: AuthRequest, res: Response, slug: string, raw: unknown): ChatLane | null {
  try {
    return resolveLane(req.user!.id, slug, raw)
  } catch (err) {
    threadError(res, err)
    return null
  }
}

router.get('/agents', (req: AuthRequest, res) => {
  const { agents, problems } = listAgents()
  // obj 900747: a bot edited outside the app (its file by hand, a built-in by a
  // release) gets its About refreshed the first time the list notices.
  ensureAboutFresh(agents)
  const about = aboutForAgents(agents)
  // obj 900748: whether each bot has High Agency on, for a badge in the list.
  let ha: ReturnType<typeof allHighAgency> = new Map()
  try { ha = allHighAgency() } catch { /* no table yet → every bot is off */ }
  // obj 900797: each bot's workspace access (no row = a bot added later: restricted, none).
  let access: ReturnType<typeof allBotWorkspaceAccess> = new Map()
  try { access = allBotWorkspaceAccess() } catch { /* no table yet → every bot reads as restricted, none */ }
  // obj 900972: where each bot has Full access right now, for the sidebar and bot-page badge.
  const fullAccess = fullAccessSummaries(req)
  res.json({
    agents: agents.map(a => {
      const h = ha.get(a.slug)
      const acc = access.get(a.slug) ?? { mode: 'restricted' as const, workspaces: [] }
      return { ...publicAgent(a, false, about.get(a.slug), workspaceAccessSummary(req, acc)), answered_by: providerFor(a), high_agency: { enabled: !!h?.enabled, level: h?.level ?? 1 }, full_access: fullAccess.get(a.slug) ?? { workspaces: [] } }
    }),
    demo: isDemoOn(),
    providers: availableProviders(),
    default_provider: installDefaultProvider(),
    // obj 900671: the bot page's tool picker, model field and web-search status.
    tool_catalog: TOOL_CATALOG,
    // obj 900863: the full enabled model registry — the SAME rows GET /api/models returns for the
    // card modal and Settings → Models — so every bot's model dropdown offers one list, one format.
    models: enabledModelsOrEmpty(),
    model_suggestions: modelSuggestions(),
    default_models: DEFAULT_MODELS,
    web: webSearchStatus(),
    // obj 900954: a bot whose file failed to load is not in `agents`; admins get it here
    // as "needs fixing". `withheld` says a shipped bot of the same slug was held back
    // rather than loaded in the broken file's place.
    ...(req.user?.role === 'admin' ? { problems: problems.map(p => ({ ...p, status: 'needs_fixing' as const })) } : {}),
  })
})

router.put('/agents/:slug/config', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    setBotConfig(a.slug, (req.body ?? {}) as Record<string, unknown>, req.user!.username)
  } catch (err) {
    if (err instanceof BotConfigError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    throw err
  }
  const updated = findAgent(a.slug)!
  syncWakeAfterBotChange(updated)
  res.json({ agent: agentResponse(updated, { force: true, reason: 'bot settings changed' }) })
})

router.delete('/agents/:slug/config', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  clearBotConfig(a.slug)
  const updated = findAgent(a.slug)!
  syncWakeAfterBotChange(updated)
  res.json({ agent: agentResponse(updated, { force: true, reason: 'bot settings reset' }) })
})

/**
 * Delete a bot for everyone (obj 900798). Admin in a signed-in browser only —
 * the same gate as changing its model or tools. The agent folder is MOVED to
 * .deleted/ inside the agents dir (restorable by hand), its High Agency wakes
 * are switched off, and every person's sidebar row for it is dropped. People's
 * chat history with it is kept. Built-in and demo bots are refused with a 409
 * that says what to do instead.
 */
router.delete('/agents/:slug', (req: AuthRequest, res) => {
  if (req.user?.role !== 'admin' || req.authVia !== 'session') {
    res.status(403).json({ error: 'Only an admin signed in to the app in the browser can delete a bot.' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  try {
    const result = deleteBotFolder(a)
    console.log(`[agent-chat] bot "${a.slug}" deleted by ${req.user!.username}; folder moved to ${result.moved_to}`)
    // A same-slug built-in hidden behind the file comes back into view.
    res.json({ ok: true, ...result, still_listed: !!findAgent(a.slug) })
  } catch (err) {
    if (err instanceof BotDeleteRefused) {
      res.status(err.status).json({ error: err.message })
      return
    }
    console.error('[agent-chat] bot delete failed:', err instanceof Error ? err.message : err)
    res.status(500).json({ error: 'The bot could not be deleted. Nothing was changed.' })
  }
})

// ── High Agency (obj 900748, levels 1-10 since obj 900794): per-bot scheduled wakes ──

/** obj 900794: a wake runs on the bot's model, so a model/provider change re-renders the wake routine (run state kept). */
function syncWakeAfterBotChange(agent: ChatAgent): void {
  try { resyncHighAgencyFor(agent) } catch (err) {
    console.warn('[agent-chat] high agency resync after bot change failed:', err instanceof Error ? err.message : err)
  }
}

function highAgencyPayload(req: AuthRequest, slug: string) {
  const isAdmin = req.user?.role === 'admin'
  return {
    high_agency: highAgencyView(slug, new Date(), findAgent(slug)),
    levels: HIGH_AGENCY_LEVELS,
    max_new_projects_per_wake: MAX_NEW_PROJECTS_PER_WAKE,
    ...(isAdmin ? { workspace_options: workspaceOptions(req.user!.id, slug) } : {}),
  }
}

function highAgencyError(res: Response, err: unknown): boolean {
  if (err instanceof HighAgencyError) {
    res.status(err.status).json({
      error: err.message,
      // obj 900914: lets the panel offer the missing grant inline.
      ...(err.code ? { code: err.code } : {}),
      ...(err.grantOptions ? { grant_options: err.grantOptions } : {}),
    })
    return true
  }
  return false
}

router.get('/agents/:slug/high-agency', (req: AuthRequest, res) => {
  const a = agentOr404(req, res)
  if (!a) return
  res.json(highAgencyPayload(req, a.slug))
})

router.put('/agents/:slug/high-agency', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    setHighAgency(a, (req.body ?? {}) as Record<string, unknown>, { id: req.user!.id, username: req.user!.username })
  } catch (err) {
    if (highAgencyError(res, err)) return
    throw err
  }
  res.json(highAgencyPayload(req, a.slug))
})

router.post('/agents/:slug/high-agency/wake', async (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    const result = await wakeNow(a, { id: req.user!.id, username: req.user!.username })
    res.status(result.ok ? 200 : 409).json({ result, ...highAgencyPayload(req, a.slug) })
  } catch (err) {
    if (highAgencyError(res, err)) return
    console.error('[agent-chat] high agency wake failed:', err instanceof Error ? err.message : err)
    res.status(500).json({ error: 'The wake failed. Try again.' })
  }
})

// ── needs_agent card wakes (obj 901328): per-bot switch, default ON ──

function cardWakesPayload(req: AuthRequest, slug: string) {
  const sw = getCardWakeSwitch(slug)
  const mine = req.user?.role === 'admin' ? null : callerWorkspaceFilter(req)
  let recent: Array<Record<string, unknown>> = []
  try {
    recent = (getDb()
      .prepare(
        `SELECT id, objective_id, workspace, need_kind, status, skip_reason, last_error, thread_id, created_at, finished_at
           FROM bot_card_wakes WHERE lower(slug) = lower(?) ORDER BY id DESC LIMIT 50`,
      )
      .all(slug) as Array<Record<string, unknown>>)
      .filter(r => !mine || mine.has(String(r.workspace)))
      .slice(0, 20)
  } catch { recent = [] }
  return { card_wakes: { ...sw, install_enabled: cardWakesGloballyEnabled(), thread_title: CARD_WAKES_THREAD_TITLE }, recent }
}

router.get('/agents/:slug/card-wakes', (req: AuthRequest, res) => {
  const a = agentOr404(req, res)
  if (!a) return
  res.json(cardWakesPayload(req, a.slug))
})

router.put('/agents/:slug/card-wakes', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be true or false' })
    return
  }
  setCardWakeSwitch(a.slug, enabled, req.user!.id)
  try {
    logActivity({
      project: 'operationkit',
      event_type: 'decision',
      title: `${a.name}: card wakes turned ${enabled ? 'on' : 'off'} by ${req.user!.username}`,
      metadata: { kind: 'bot_card_wakes_switched', slug: a.slug, enabled },
    })
  } catch { /* the feed never decides the change */ }
  res.json(cardWakesPayload(req, a.slug))
})

// ── Workspace access (obj 900797): which workspaces a global bot may work in ──

function workspaceAccessPayload(req: AuthRequest, slug: string) {
  const a = getBotWorkspaceAccess(slug)
  const isAdmin = req.user?.role === 'admin'
  if (isAdmin) {
    let options: { slug: string; name: string }[] = []
    try { options = listWorkspaces().map(w => ({ slug: w.slug, name: w.name })) } catch { options = [] }
    return { access: a, workspace_options: options }
  }
  // A member sees the bot's access only for workspaces they belong to (no other workspace names).
  const mine = callerWorkspaceFilter(req)!
  return {
    access: { ...a, workspaces: a.workspaces.filter(w => mine.has(w)), grants: a.grants.filter(g => mine.has(g.workspace)) },
  }
}

function workspaceAccessError(res: Response, err: unknown): boolean {
  if (err instanceof BotWorkspaceError) {
    res.status(err.status).json({ error: err.message })
    return true
  }
  return false
}

function logAccessChange(req: AuthRequest, a: ChatAgent, action: 'granted' | 'revoked' | 'set', workspaces: string[], detail?: string): void {
  try {
    logActivity({
      project: 'operationkit',
      workspace: workspaces.length === 1 ? workspaces[0] : undefined,
      event_type: 'decision',
      title: action === 'set'
        ? `Workspace access for ${a.name} set to: ${workspaces.join(', ') || 'none'}`
        : `${a.name} ${action} workspace ${workspaces.join(', ')}`,
      detail: detail ?? null,
      metadata: { kind: `bot_workspace_${action}`, slug: a.slug, workspaces, actor: req.user!.username },
    })
  } catch { /* the activity feed is best-effort */ }
}

router.get('/agents/:slug/workspaces', (req: AuthRequest, res) => {
  const a = agentOr404(req, res)
  if (!a) return
  res.json(workspaceAccessPayload(req, a.slug))
})

router.put('/agents/:slug/workspaces', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    const r = setBotWorkspaces(a.slug, (req.body ?? {}).workspaces, req.user!.username)
    const haOff = reconcileHighAgencyAccess(a.slug, req.user!.username)
    // obj 900972: Full access ends with the workspace it was granted in.
    const faOff = dropFullAccessForRevokedWorkspaces(a.slug, req.user!.username)
    logAccessChange(req, a, 'set', r.access.workspaces, haOff ? 'High Agency switched off: its wake workspace is no longer granted' : undefined)
    res.json({ ...workspaceAccessPayload(req, a.slug), high_agency_switched_off: haOff, full_access_switched_off: faOff })
  } catch (err) {
    if (workspaceAccessError(res, err)) return
    throw err
  }
})

router.post('/agents/:slug/workspaces', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    const r = grantBotWorkspace(a.slug, (req.body ?? {}).workspace, req.user!.username)
    // Restricting an unrestricted bot can take its High Agency workspace away.
    const haOff = r.restrictedNow ? reconcileHighAgencyAccess(a.slug, req.user!.username) : false
    if (r.changed) logAccessChange(req, a, 'granted', [String(req.body.workspace)], r.restrictedNow ? 'The bot is now restricted to its granted workspaces' : undefined)
    res.status(r.changed ? 201 : 200).json({ ...workspaceAccessPayload(req, a.slug), high_agency_switched_off: haOff })
  } catch (err) {
    if (workspaceAccessError(res, err)) return
    throw err
  }
})

router.delete('/agents/:slug/workspaces/:workspace', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    const ws = String(req.params.workspace)
    const r = revokeBotWorkspace(a.slug, ws, req.user!.username)
    const haOff = reconcileHighAgencyAccess(a.slug, req.user!.username)
    const faOff = dropFullAccessForRevokedWorkspaces(a.slug, req.user!.username)
    if (r.changed) logAccessChange(req, a, 'revoked', [ws], haOff ? 'High Agency switched off: it woke in this workspace' : undefined)
    res.json({ ...workspaceAccessPayload(req, a.slug), high_agency_switched_off: haOff, full_access_switched_off: faOff })
  } catch (err) {
    if (workspaceAccessError(res, err)) return
    throw err
  }
})

router.get('/agents/:slug', (req: AuthRequest, res) => {
  const a = agentOr404(req, res)
  if (!a) return
  res.json({ agent: agentResponse(a) })
})

router.get('/agents/:slug/messages', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const lane = laneOr404(req, res, a.slug, req.query.thread_id)
  if (!lane) return
  const after = Number(req.query.after) || 0
  // obj 900949: a queue left behind (a restart mid-turn) is picked up the next
  // time the person looks at the lane, so a queued message never waits forever.
  drainLaneQueue({ userId: req.user!.id, username: req.user!.username, agent: a, lane })
  const messages = markActivityMessages(listMessages(req.user!.id, a.slug, { afterId: after, lane }))
  res.json({ messages, ...attachments(req.user!.id, a.slug, messages), turn: laneTurnState(req.user!.id, a.slug, lane) })
})

/**
 * Stop the turn running in this lane (obj 900949). Messages already queued are
 * kept and delivered next; `drop_queued: true` discards them as well, and the
 * client only sends it after the person confirmed.
 */
router.post('/agents/:slug/stop', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Use the MCP tools to work with agents from another AI client' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const lane = laneOr404(req, res, a.slug, req.body?.thread_id)
  if (!lane) return
  const r = stopTurn(req.user!.id, a.slug, lane, { dropQueued: req.body?.drop_queued === true })
  res.json({ stopped: r.stopped, dropped: r.dropped, turn: { running: r.running, queued: r.queued } })
})

// ── side threads / concurrent task lanes (obj 900370) ──

router.get('/agents/:slug/threads', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const threads = listThreads(req.user!.id, a.slug, { includeArchived: req.query.archived === '1' })
  res.json({ threads, max_open: maxThreadsPerBot() })
})

router.post('/agents/:slug/threads', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  try {
    res.status(201).json({ thread: createThread(req.user!.id, a.slug, (req.body ?? {}).title) })
  } catch (err) {
    threadError(res, err)
  }
})

router.patch('/agents/:slug/threads/:id', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    res.json({ thread: updateThread(req.user!.id, a.slug, Number(req.params.id), { title: b.title, pinned: b.pinned, archived: b.archived }) })
  } catch (err) {
    threadError(res, err)
  }
})

/**
 * Delete a side thread outright. The lane's messages and images go with it; the
 * main conversation is not read or written by this path at all.
 */
router.delete('/agents/:slug/threads/:id', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const lane = laneOr404(req, res, a.slug, req.params.id)
  if (!lane) return
  const removed = clearChat(req.user!.id, a.slug, lane)
  deleteThread(req.user!.id, a.slug, Number(req.params.id))
  res.json({ ok: true, removed })
})

router.post('/agents/:slug/messages', async (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Use the MCP tools to work with agents from another AI client' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const lane = laneOr404(req, res, a.slug, req.body?.thread_id)
  if (!lane) return
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  let images: IncomingImage[]
  try {
    images = parseIncomingImages(req.body?.images)
  } catch (err) {
    res.status(400).json({ error: err instanceof ImageRejected ? err.message : 'That attachment could not be read.' })
    return
  }
  // A pasted screenshot on its own is a perfectly good message, so text is only
  // required when nothing is attached.
  if (!text && images.length === 0) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  if (text.length > 8000) {
    res.status(400).json({ error: 'Message is too long (8,000 characters max)' })
    return
  }
  // obj 900977: the client's idempotency key. Optional (older clients, scripts);
  // a malformed one is refused rather than stored.
  const rawId = req.body?.client_msg_id
  if (rawId !== undefined && rawId !== null && (typeof rawId !== 'string' || !CLIENT_MSG_ID_RE.test(rawId))) {
    res.status(400).json({ error: 'client_msg_id must be 8-64 letters, digits, "-" or "_"' })
    return
  }
  const clientMsgId = typeof rawId === 'string' ? rawId : undefined
  // obj 901329: a response that closes before we answer (tab closed, page
  // reloaded, network blip, the client's own 240s UI timeout, a proxy hanging
  // up) is NOT the person pressing Stop. The turn is never bound to this
  // request: it runs to the end and stores its answer, which the person sees
  // when they come back. Only POST /agents/:slug/stop cancels a turn.
  let disconnectedAt: number | null = null
  const startedAt = Date.now()
  const where = `user=${req.user!.id} bot=${a.slug} lane=${lane.kind === 'main' ? 'main' : `thread:${lane.id}`}`
  res.on('close', () => {
    if (res.writableEnded) return
    disconnectedAt = Date.now()
    console.warn(`[agent-chat] disconnect: response closed mid-turn after ${disconnectedAt - startedAt}ms (${where}) — not a Stop; the turn keeps running`)
  })
  try {
    // obj 900949: a lane that is busy QUEUES the message (202) instead of
    // refusing it; the turn that follows the running one delivers it, in order.
    const r = await submitMessage({ userId: req.user!.id, username: req.user!.username, agent: a, text, images, lane, clientMsgId, responseGone: () => disconnectedAt !== null })
    if (disconnectedAt !== null) {
      console.log(`[agent-chat] disconnect: turn finished ${Date.now() - disconnectedAt}ms after the response closed (${where}); ${r.messages.length} row(s) stored for the person to see on return`)
      return
    }
    res.status(r.queued ? 202 : 200).json({
      messages: r.messages,
      ...attachments(req.user!.id, a.slug, r.messages),
      queued: r.queued,
      // obj 900977: true when this client_msg_id was already stored — nothing new was added or run.
      ...(r.duplicate ? { duplicate: true } : {}),
      turn: laneTurnState(req.user!.id, a.slug, lane),
    })
  } catch (err) {
    if (disconnectedAt !== null) {
      console.warn(`[agent-chat] disconnect: turn ended with an error after the response closed (${where}):`, err instanceof Error ? err.message : err)
      return
    }
    if (err instanceof ChatBusyError) {
      res.status(409).json({ error: err.message })
      return
    }
    if (err instanceof ChatUnavailableError) {
      // No seat could answer (obj 900624): a real error status the UI shows as
      // "message not sent", not a 200 with an error row in the transcript.
      res.setHeader('Retry-After', '30')
      res.status(err.status).json({ error: err.message, code: 'ai_unavailable', reason: err.reason, messages: err.messages })
      return
    }
    console.error('[agent-chat] turn failed:', err instanceof Error ? err.message : err)
    res.status(500).json({ error: 'The chat failed. Try again.' })
  }
})

router.delete('/agents/:slug/messages', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const slug = String(req.params.slug)
  const lane = laneOr404(req, res, slug, req.query.thread_id)
  if (!lane) return
  const removed = clearChat(req.user!.id, slug, lane)
  res.json({ ok: true, removed })
})

/**
 * One attached image (obj 900157). Strictly the person who attached it: the
 * same per-person rule the messages follow. Served with nosniff + a locked-down
 * CSP and never as an attachment download, so a stored byte string can't be
 * talked into executing in the app's origin.
 */
router.get('/attachments/:id', (req: AuthRequest, res) => {
  const id = Number(req.params.id)
  const a = Number.isInteger(id) ? getAttachment(id) : null
  if (!a || a.user_id !== req.user!.id) {
    res.status(404).json({ error: 'Attachment not found' })
    return
  }
  res.set({
    'Content-Type': a.media_type,
    'Content-Length': String(a.bytes.length),
    'Content-Disposition': `inline; filename="${a.name.replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  })
  res.end(a.bytes)
})

/**
 * One card_browser screenshot (obj 901027 security review). Same per-person
 * ownership rule as /attachments/:id: only the person who was chatting with
 * the bot when the shot was taken may fetch it — never the raw base64 inline
 * in a tool result.
 */
router.get('/sandbox-screenshots/:id', (req: AuthRequest, res) => {
  const id = Number(req.params.id)
  const s = Number.isInteger(id) ? getSandboxScreenshot(id) : null
  if (!s || s.user_id !== req.user!.id) {
    res.status(404).json({ error: 'Screenshot not found' })
    return
  }
  res.set({
    'Content-Type': s.media_type,
    'Content-Length': String(s.bytes.length),
    'Content-Disposition': 'inline; filename="screenshot.png"',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  })
  res.end(s.bytes)
})

// ── drafts: only the owning person, only from a signed-in browser ──

function ownDraft(req: AuthRequest, res: Response): DraftRow | null {
  const d = getDraft(Number(req.params.id))
  if (!d || d.user_id !== req.user!.id) {
    res.status(404).json({ error: 'Draft not found' })
    return null
  }
  return d
}

function signedInBrowser(req: AuthRequest): boolean {
  return !!req.cookies?.token && req.authVia !== 'agent_api_key' && req.authVia !== 'legacy_api_key'
}

router.put('/drafts/:id', (req: AuthRequest, res) => {
  const d = ownDraft(req, res)
  if (!d) return
  if (d.status !== 'draft') {
    res.status(409).json({ error: `This draft is already ${d.status}` })
    return
  }
  const b = (req.body ?? {}) as Record<string, unknown>
  const pick = (k: string, cur: string) => (typeof b[k] === 'string' ? (b[k] as string) : cur)
  let payload: EmailDraft | EventDraft
  if (d.kind === 'email') {
    const p = d.payload as EmailDraft
    payload = { ...p, to: pick('to', p.to), subject: pick('subject', p.subject), body: pick('body', p.body) }
  } else {
    const p = d.payload as EventDraft
    payload = { ...p, title: pick('title', p.title), start: pick('start', p.start), end: pick('end', p.end) }
    if (Number.isNaN(Date.parse(payload.start)) || Number.isNaN(Date.parse(payload.end))) {
      res.status(400).json({ error: 'start/end must be valid dates' })
      return
    }
  }
  getDb().prepare("UPDATE agent_chat_drafts SET payload = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(payload), d.id)
  res.json({ draft: getDraft(d.id) })
})

// A click in flight per draft: a double-click must not send twice.
const draftsInFlight = new Set<number>()

/**
 * The person's Send / "Add to calendar" click (obj 901331): the ONLY path that
 * delivers a draft. Signed-in browser of the draft's own person only; agent
 * keys and tools can never reach it. A Google draft is sent from the clicking
 * person's own account, and only if it is still the account it was made for.
 */
router.post('/drafts/:id/send', async (req: AuthRequest, res) => {
  if (!signedInBrowser(req)) {
    res.status(403).json({ error: 'Only the person, signed in to the app, can send a draft' })
    return
  }
  const d = ownDraft(req, res)
  if (!d) return
  if (d.status !== 'draft') {
    res.status(409).json({ error: `This draft is already ${d.status}` })
    return
  }
  if (draftsInFlight.has(d.id)) {
    res.status(409).json({ error: 'This draft is already being sent' })
    return
  }
  const delivery = resolveDelivery(req.user!.id, d.connector)
  if (!delivery) {
    res.status(409).json({ error: d.kind === 'email' ? 'The email account this draft was made for is not connected any more' : 'The calendar this draft was made for is not connected any more' })
    return
  }
  draftsInFlight.add(d.id)
  try {
    if (d.kind === 'email') {
      await delivery.sendEmail(d.payload as EmailDraft)
      setDraftStatus(d.id, 'sent')
    } else {
      await delivery.addEvent(d.payload as EventDraft)
      setDraftStatus(d.id, 'added')
    }
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
    return
  } finally {
    draftsInFlight.delete(d.id)
  }
  res.json({ draft: getDraft(d.id) })
})

router.post('/drafts/:id/discard', async (req: AuthRequest, res) => {
  const d = ownDraft(req, res)
  if (!d) return
  if (d.status !== 'draft') {
    res.status(409).json({ error: `This draft is already ${d.status}` })
    return
  }
  // Also remove the copy in the Gmail Drafts folder. Best effort: the chat draft
  // is discarded either way, and a leftover Gmail draft never sends by itself.
  if (d.kind === 'email' && (d.payload as EmailDraft).remote_id && signedInBrowser(req)) {
    try { await resolveDelivery(req.user!.id, d.connector)?.discardEmail(d.payload as EmailDraft) } catch { /* left in Gmail Drafts */ }
  }
  setDraftStatus(d.id, 'discarded')
  res.json({ draft: getDraft(d.id) })
})

// ── install settings (admin) ──

router.put('/settings', (req: AuthRequest, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admins only' })
    return
  }
  const b = (req.body ?? {}) as { demo?: unknown; default_provider?: unknown }
  if (b.demo !== undefined) {
    const on = b.demo === true
    setSetting('agent_chat_demo', on ? '1' : '0')
    if (on) {
      try {
        seedDemoKnowledge()
      } catch (err) {
        res.status(500).json({ error: `Could not copy the demo notes into the knowledge base: ${err instanceof Error ? err.message : err}` })
        return
      }
    }
  }
  if (b.default_provider !== undefined) {
    const p = typeof b.default_provider === 'string' ? b.default_provider : ''
    if (p && !(CHAT_PROVIDERS as readonly string[]).includes(p)) {
      res.status(400).json({ error: `default_provider must be one of ${CHAT_PROVIDERS.join(', ')} (or empty for automatic)` })
      return
    }
    setSetting('agent_chat_default_provider', p)
  }
  res.json({ demo: isDemoOn(), default_provider: installDefaultProvider() })
})

export default router
