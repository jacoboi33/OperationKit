/**
 * "Approve on my behalf" grants for a bot (obj 900839), on the bot's settings
 * page: Settings → Bots → <bot>.
 *
 *   GET    /api/agent-chat/agents/:slug/delegations       admin: list + options
 *   POST   /api/agent-chat/agents/:slug/delegations       owner: issue a grant
 *   DELETE /api/agent-chat/agents/:slug/delegations/:id   owner: revoke
 *   POST   /api/agent-chat/agents/:slug/registry          owner: register this bot (obj 900862)
 *
 * Issuing and revoking are the OWNER's browser click only: an admin signed in
 * with the httpOnly cookie. An agent key, a legacy API key and a Bearer JWT
 * are all refused, so a bot can never grant, widen or extend its own
 * approvals — and there is deliberately no update route: a grant cannot be
 * extended, only revoked and re-issued.
 *
 * The grant is issued for the REGISTRY bot this chat bot speaks as
 * (services/bots/bot-registry.ts), because that is the name a bot puts on the
 * approval message. Every chat bot has one with no manual step (obj 900862,
 * services/bots/register-chat-bot.ts `chatBotIdentity`): one the stored
 * registry does not know gets an identity derived from its file on each read
 * (nothing is written). Only when none can be derived does the page fall back
 * to the owner's one-click register — never a hand-edited settings row.
 */
import { Router, type Response } from 'express'
import type { DelegationGrantsResponse } from '@operationkit/shared'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { findAgent } from '../services/agent-chat/engine.js'
import type { ChatAgent } from '../services/agent-chat/agent-defs.js'
import type { BotDefinition } from '../services/bots/bot-registry.js'
import { chatBotIdentity, registerChatBot, registrationOptions, type ChatBotIdentity } from '../services/bots/register-chat-bot.js'
import { listWorkspaces } from '../services/workspaces.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import {
  createGrant,
  DelegationError,
  listGrantsForBot,
  revokeGrant,
} from '../services/delegated-approvals.js'
import { logActivity } from './feed.js'

const router: Router = Router()

/** The signed-in owner, in the browser. Everything else is refused. */
export function isOwnerBrowserSession(req: AuthRequest): boolean {
  return (
    req.user?.role === 'admin' &&
    req.authVia === 'session' &&
    !req.agentKey &&
    authenticatedViaCookie(req)
  )
}

function ownerOr403(req: AuthRequest, res: Response): boolean {
  if (isOwnerBrowserSession(req)) return true
  res.status(403).json({
    error: 'Only the owner, signed in to the app in the browser, can issue or revoke an approval grant. A bot or an API key can never grant itself approvals.',
    code: 'owner_only',
  })
  return false
}

function agentOr404(req: AuthRequest, res: Response): ChatAgent | null {
  const a = findAgent(String(req.params.slug))
  if (!a) res.status(404).json({ error: `No agent "${req.params.slug}" on this install` })
  return a
}

/**
 * The bot identity a chat bot holds grants under: the registry bot it speaks
 * as (its slug first, then its names), else one derived automatically from its
 * file (obj 900862) — so every bot can hold a grant with no registry step.
 */
export function botIdentityFor(a: Pick<ChatAgent, 'slug' | 'name' | 'file_name'>): ChatBotIdentity | null {
  return chatBotIdentity(a, getDb())
}

export function registryBotFor(a: Pick<ChatAgent, 'slug' | 'name' | 'file_name'>): BotDefinition | null {
  return botIdentityFor(a)?.bot ?? null
}

function workspaceOptions(): { slug: string; name: string }[] {
  try {
    return listWorkspaces().map(w => ({ slug: w.slug, name: w.name }))
  } catch {
    return []
  }
}

function payload(req: AuthRequest, a: ChatAgent): DelegationGrantsResponse {
  const identity = botIdentityFor(a)
  const bot = identity?.bot ?? null
  if (!bot) {
    const canManage = isOwnerBrowserSession(req)
    return {
      bot: null,
      bot_unavailable_reason: canManage
        ? `${a.name} isn't registered as a bot yet, so its approvals can't be matched to a grant. Register it below — one click, no settings to edit.`
        : `${a.name} isn't registered as a bot yet, so its approvals can't be matched to a grant. The owner can register it here, signed in in the browser.`,
      workspace_options: [],
      grants: [],
      can_manage: canManage,
      registration: registrationOptions(a, getDb()),
    }
  }
  return {
    bot: { id: bot.id, name: bot.name },
    ...(identity?.auto ? { bot_auto: { linked: identity.linked } } : {}),
    workspace_options: workspaceOptions(),
    grants: listGrantsForBot(getDb(), bot.id),
    can_manage: isOwnerBrowserSession(req),
  }
}

function delegationError(res: Response, err: unknown): boolean {
  if (err instanceof DelegationError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return true
  }
  return false
}

router.get('/agents/:slug/delegations', (req: AuthRequest, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Only the owner can see approval grants.', code: 'owner_only' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  res.json(payload(req, a))
})

router.post('/agents/:slug/delegations', (req: AuthRequest, res) => {
  if (!ownerOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  const bot = registryBotFor(a)
  if (!bot) {
    res.status(409).json({ error: `${a.name} is not in the bot registry, so it cannot hold a grant.`, code: 'bot_not_registered' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  try {
    const grant = createGrant(getDb(), {
      grantor: { id: req.user!.id, username: req.user!.username },
      botName: bot.id,
      agentSlug: a.slug,
      workspace: body.workspace,
      actions: body.actions,
      expiresAt: body.expires_at,
      allowedWorkspaces: workspaceOptions().map(w => w.slug),
    })
    try {
      logActivity({
        project: 'operationkit',
        workspace: grant.workspace,
        event_type: 'decision',
        title: `${req.user!.username} let ${bot.name} approve ${grant.actions.join(', ')} in ${grant.workspace} on their behalf (grant #${grant.id})`,
        detail: `Expires ${grant.expires_at} UTC`,
        metadata: { kind: 'delegation_grant_created', grant_id: grant.id, bot: bot.id, slug: a.slug, actions: grant.actions, actor: req.user!.username },
      })
    } catch { /* the activity feed is best-effort; the audit table already has it */ }
    res.status(201).json({ ...payload(req, a), created: grant })
  } catch (err) {
    if (delegationError(res, err)) return
    throw err
  }
})

/**
 * Register this chat bot in the bot registry (obj 900862) — the owner's one
 * click that replaces hand-editing settings.bot_registry / bot_agent_slugs.
 * Body: { bot?: string } — an existing registry bot to link to; omitted/null =
 * a new bot named after this chat bot. Owner (cookie) only, like a grant.
 */
router.post('/agents/:slug/registry', (req: AuthRequest, res) => {
  if (!ownerOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  const body = (req.body ?? {}) as Record<string, unknown>
  const r = registerChatBot(getDb(), a, body.bot)
  if (!r.ok) {
    res.status(r.status).json({ error: r.error, code: r.code })
    return
  }
  try {
    logActivity({
      project: 'operationkit',
      event_type: 'decision',
      title: r.linked
        ? `${req.user!.username} registered ${a.name} (${a.slug}) as the bot "${r.bot.id}"`
        : `${req.user!.username} registered ${a.name} (${a.slug}) as a new bot "${r.bot.id}"`,
      metadata: { kind: 'bot_registered', bot: r.bot.id, slug: a.slug, linked: r.linked, actor: req.user!.username },
    })
  } catch { /* best-effort */ }
  res.status(201).json({ ...payload(req, a), registered: { id: r.bot.id, name: r.bot.name, linked: r.linked } })
})

router.delete('/agents/:slug/delegations/:id', (req: AuthRequest, res) => {
  if (!ownerOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  const bot = registryBotFor(a)
  const id = Number(req.params.id)
  if (!bot || !Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'No such grant for this bot.', code: 'grant_not_found' })
    return
  }
  try {
    const r = revokeGrant(getDb(), id, bot.id, req.user!.username)
    if (r.changed) {
      try {
        logActivity({
          project: 'operationkit',
          workspace: r.grant.workspace,
          event_type: 'decision',
          title: `${req.user!.username} revoked grant #${id} (${bot.name} approving on their behalf in ${r.grant.workspace})`,
          metadata: { kind: 'delegation_grant_revoked', grant_id: id, bot: bot.id, slug: a.slug, actor: req.user!.username },
        })
      } catch { /* best-effort */ }
    }
    res.json({ ...payload(req, a), revoked: r.grant })
  } catch (err) {
    if (delegationError(res, err)) return
    throw err
  }
})

export default router
