/**
 * Bot Full access, per workspace (obj 900972), on the bot's settings page.
 *
 *   GET /api/agent-chat/agents/:slug/full-access              the bot's Full access, per granted workspace, + the audit log
 *   PUT /api/agent-chat/agents/:slug/full-access/:workspace   admin: switch it on/off, set or clear the expiry, switch an exclusion
 *
 * Changing it is an ADMIN's browser click only: the httpOnly cookie session of
 * an admin. An agent key, a legacy API key, a Bearer JWT and a card session
 * token are all refused, so a bot can never give itself Full access or lift
 * one of its exclusions — the same rule as "approve on my behalf" grants.
 * Nothing here widens what any API key may do.
 *
 * A member sees only the workspaces they belong to (and no audit rows for
 * others), the same narrowing as the workspace access list.
 *
 * Every change is written twice: one row per change in the Full access audit
 * table (who, when, bot, workspace, on/off, expiry, which exclusion), and one
 * line in the activity feed.
 */
import { Router, type Response } from 'express'
import {
  FULL_ACCESS_EXCLUSION_LABELS,
  type BotFullAccessResponse,
  type BotFullAccessSummary,
  type FullAccessAuditEvent,
} from '@operationkit/shared'
import type { AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { findAgent } from '../services/agent-chat/engine.js'
import type { ChatAgent } from '../services/agent-chat/agent-defs.js'
import {
  allActiveFullAccess,
  FullAccessError,
  listFullAccess,
  listFullAccessAudit,
  setFullAccess,
} from '../services/agent-chat/bot-full-access.js'
import { listWorkspaces } from '../services/workspaces.js'
import { isOwnerBrowserSession } from './agent-chat-delegations.js'
import { logActivity } from './feed.js'

const router: Router = Router()

function agentOr404(req: AuthRequest, res: Response): ChatAgent | null {
  const a = findAgent(String(req.params.slug))
  if (!a) res.status(404).json({ error: `No agent "${req.params.slug}" on this install` })
  return a
}

/** null = the caller sees every workspace (admin); else the slugs they belong to. */
function callerWorkspaces(req: AuthRequest): Set<string> | null {
  if (req.user?.role === 'admin') return null
  return new Set(getUserWorkspaces(req.user!.id).map(w => w.workspace))
}

function payload(req: AuthRequest, slug: string): BotFullAccessResponse {
  const mine = callerWorkspaces(req)
  const all = listFullAccess(slug)
  const workspaces = mine ? all.filter(a => mine.has(a.workspace)) : all
  let options: { slug: string; name: string }[] = []
  try {
    options = listWorkspaces().map(w => ({ slug: w.slug, name: w.name })).filter(w => !mine || mine.has(w.slug))
  } catch { options = [] }
  return {
    slug,
    workspaces,
    workspace_options: options,
    can_manage: isOwnerBrowserSession(req),
    audit: listFullAccessAudit(slug, { limit: 50, workspaces: mine ? [...mine] : null }),
  }
}

/**
 * Every bot's ACTIVE Full access, for the bot list (the sidebar and bot-page
 * badge). A member only gets the workspaces they belong to.
 */
export function fullAccessSummaries(req: AuthRequest): Map<string, BotFullAccessSummary> {
  const out = new Map<string, BotFullAccessSummary>()
  const mine = callerWorkspaces(req)
  let active: ReturnType<typeof allActiveFullAccess>
  try { active = allActiveFullAccess() } catch { return out }
  for (const [slug, list] of active) {
    const visible = mine ? list.filter(w => mine.has(w.workspace)) : list
    if (visible.length > 0) out.set(slug, { workspaces: visible })
  }
  return out
}

const CHANGE_WORDS: Record<FullAccessAuditEvent, string> = {
  enabled: 'switched on',
  disabled: 'switched off',
  expiry_changed: 'expiry changed',
  exclusion_changed: 'an exclusion changed',
  expired: 'expired',
  workspace_revoked: 'ended (workspace revoked)',
  ability_used: 'used',
  ability_refused: 'refused',
  exclusion_refused: 'exclusion refused',
  protected_refused: 'protected card refused',
}

router.get('/agents/:slug/full-access', (req: AuthRequest, res) => {
  const a = agentOr404(req, res)
  if (!a) return
  res.json(payload(req, a.slug))
})

router.put('/agents/:slug/full-access/:workspace', (req: AuthRequest, res) => {
  if (!isOwnerBrowserSession(req)) {
    res.status(403).json({
      error: 'Only an admin, signed in to the app in the browser, can change a bot\'s Full access. A bot or an API key can never give itself Full access.',
      code: 'admin_only',
    })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const workspace = String(req.params.workspace)
  try {
    const r = setFullAccess(a.slug, workspace, req.body ?? {}, { id: req.user!.id, username: req.user!.username })
    if (r.changes.length > 0) {
      try {
        const allowed = Object.entries(r.access.allow).filter(([, v]) => v).map(([k]) => FULL_ACCESS_EXCLUSION_LABELS[k as keyof typeof FULL_ACCESS_EXCLUSION_LABELS])
        logActivity({
          project: 'operationkit',
          workspace,
          event_type: 'decision',
          title: `Full access for ${a.name} in ${workspace}: ${[...new Set(r.changes.map(c => CHANGE_WORDS[c]))].join(', ')}`,
          detail: r.access.state === 'on'
            ? `On${r.access.expires_at ? ` until ${r.access.expires_at} UTC` : ', no expiry'}. Allowed exclusions: ${allowed.join(', ') || 'none'}.`
            : 'Off.',
          metadata: {
            kind: 'bot_full_access_changed',
            slug: a.slug,
            workspace,
            enabled: r.access.state === 'on',
            expires_at: r.access.expires_at,
            allow: r.access.allow,
            changes: r.changes,
            actor: req.user!.username,
          },
        })
      } catch { /* the activity feed is best-effort; the audit table already has the rows */ }
    }
    res.json({ ...payload(req, a.slug), changes: r.changes })
  } catch (err) {
    if (err instanceof FullAccessError) {
      res.status(err.status).json({ error: err.message, code: err.code })
      return
    }
    throw err
  }
})

export default router
