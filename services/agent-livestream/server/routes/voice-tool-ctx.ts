/**
 * Voice-tool sandbox context endpoint.
 *
 * POST /api/voice-tool/ctx
 *   Authorization: Bearer <voice-tool-jwt>
 *
 * Returns the SSH context needed for the sandbox agent runner:
 *   { host, sandboxId, privateKey }
 *
 * POST /api/voice-tool/dispatch
 *   Authorization: Bearer <voice-tool-jwt>
 *   Body: { spec_url: string }
 *
 * Layer-2 mock dispatch: fetches the markdown spec, creates a `skill`
 * resource (linked into the user's project graph as `parent`), and inserts
 * an `active` process row scoped to the user's project. No real agent runs
 * yet — the row alone makes a cursor appear in the dashboard's terrain view.
 * Returns a relative dashboard URL focused on the new skill so the chat
 * iframe (same-origin) renders it zoomed in without re-login.
 *
 * Future (Layer 3): SSH into the user's sandbox and invoke `duoidal execute`
 * against the freshly-created skill resource (mirrors research-tool's
 * sandbox-runner pattern).
 *
 * Uses voice-tool JWT auth (not Supabase JWT) — sits outside the JWT wall.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyVoiceToolJwt, VoiceToolJwtError } from '../lib/voice-tool-jwt.js'
import { resolveSandboxCtx } from '../lib/resolve-sandbox-ctx.js'
import { getServices } from '../lib/services.js'
import { createLogger } from '@skill-networks/logger'
import { createRateLimiter } from '../middleware/rate-limit.js'

const logger = createLogger('agent-livestream:voice-tool-ctx')

const dispatchRateLimiter = createRateLimiter({ max: 20, windowMs: 60_000 })

async function requireVoiceToolAuth(c: Context): Promise<{ userId: string; activeProject?: string } | Response> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Authentication required' }, 401)
  }
  const token = authHeader.slice(7)
  const secret = process.env['VOICE_TOOL_JWT_SECRET']
  if (!secret) {
    return c.json({ error: 'Voice tool not configured' }, 503)
  }
  try {
    const claims = await verifyVoiceToolJwt(token, secret)
    return { userId: claims.user_id, activeProject: claims.active_project }
  } catch (e) {
    if (e instanceof VoiceToolJwtError) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }
    throw e
  }
}

/**
 * Extract a kebab-case slug from the first H1 in a markdown body.
 * Returns null if no H1 is present so the caller can fall back to a timestamp.
 */
function extractSlug(md: string): string | null {
  const h1 = md.match(/^#\s+(.+?)\s*$/m)
  if (!h1) return null
  const slug = h1[1]
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || null
}

const ERROR_TO_HTTP: Record<string, { status: 401 | 403 | 404 | 503; message: string }> = {
  'user-not-found': { status: 403, message: 'User not found' },
  'no-sandbox': { status: 404, message: 'No sandbox found' },
  'sandbox-ip-unavailable': { status: 503, message: 'Sandbox IP not available' },
  'ssh-key-unavailable': { status: 503, message: 'SSH credentials not configured' },
}

export function createVoiceToolCtxRouter(deps: { db: SupabaseClient }): Hono {
  const router = new Hono()

  router.post('/ctx', async (c) => {
    const auth = await requireVoiceToolAuth(c)
    if (auth instanceof Response) return auth
    const { userId } = auth

    const result = await resolveSandboxCtx(deps.db, userId)
    if (result.error) {
      const mapped = ERROR_TO_HTTP[result.error] ?? { status: 500 as const, message: 'Internal error' }
      return c.json({ error: mapped.message }, mapped.status)
    }
    if (!result.ctx) {
      logger.error('resolveSandboxCtx returned no error and no ctx', {})
      return c.json({ error: 'Internal error' }, 500)
    }

    logger.info('Resolved sandbox ctx for voice agent', { sandboxId: result.ctx.sandboxId })

    return c.json(result.ctx)
  })

  router.post('/dispatch', dispatchRateLimiter, async (c) => {
    const auth = await requireVoiceToolAuth(c)
    if (auth instanceof Response) return auth
    const { userId, activeProject } = auth

    let body: { spec_url?: unknown } = {}
    try { body = await c.req.json() } catch { /* empty body OK; we accept and validate */ }
    const specUrl = body.spec_url
    if (typeof specUrl !== 'string' || specUrl.trim().length === 0) {
      return c.json({ error: 'spec_url required' }, 400)
    }
    let parsed: URL
    try {
      parsed = new URL(specUrl)
    } catch {
      return c.json({ error: 'spec_url must be a valid URL' }, 400)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return c.json({ error: 'spec_url must be http or https' }, 400)
    }
    // Block SSRF: reject private/loopback IPv4 addresses (RFC 1918, link-local, loopback).
    const hostname = parsed.hostname.toLowerCase()
    if (/^(localhost$|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(hostname)) {
      return c.json({ error: 'spec_url cannot target private network addresses' }, 400)
    }
    // Block SSRF via IPv6: loopback (::1), IPv4-mapped (::ffff:), unique-local (fc/fd), link-local (fe80+).
    if (/^(\[::1\]$|\[::ffff:|\[fc[0-9a-f]|\[fd[0-9a-f]|\[fe[89ab][0-9a-f])/.test(hostname)) {
      return c.json({ error: 'spec_url cannot target private network addresses' }, 400)
    }

    const fallbackProjectName = `project:${userId}`
    const { processes, resources, events } = getServices()

    // 1. Resolve the project to dispatch into.
    //    Preference order:
    //      a. The activeProject from the voice-tool JWT (the project the user
    //         was viewing in the top bar at chat-join time) — verified to be
    //         a project the user has access to via resolveUserProjects.
    //      b. Fallback to the per-user `project:<userId>` resource — always
    //         exists, scoped to the caller.
    let projectName = fallbackProjectName
    if (activeProject && activeProject !== fallbackProjectName) {
      try {
        const allowedProjectIds = await resources.resolveUserProjects(userId)
        const candidate = await resources.findByNameAndType(activeProject, 'project')
        if (candidate && allowedProjectIds.has(candidate.id)) {
          projectName = activeProject
        } else {
          logger.warn('dispatch: activeProject not accessible to user; falling back', {
            userId, activeProject, candidateExists: !!candidate,
          })
        }
      } catch (e) {
        logger.warn('dispatch: activeProject access check failed; falling back', {
          userId, activeProject, error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    const projectResource = await resources.findByNameAndType(projectName, 'project')
    if (!projectResource) {
      logger.warn('dispatch: no project resource for user', { userId, projectName })
      return c.json({ error: 'Project resource not found for user' }, 404)
    }

    // 2. Fetch the markdown spec body. Cap to 50KB so a misbehaving URL
    //    can't blow out the resources.config payload.
    let specBody: string
    try {
      // redirect: 'error' prevents open-redirect SSRF (attacker supplies a public URL that
      // redirects to 169.254.169.254 or another blocked address, bypassing the hostname check).
      const specResp = await fetch(specUrl, { signal: AbortSignal.timeout(8_000), redirect: 'error' })
      if (!specResp.ok) {
        return c.json({ error: `spec_url returned ${specResp.status}` }, 400)
      }
      specBody = await specResp.text()
      if (specBody.length > 50_000) specBody = specBody.slice(0, 50_000)
    } catch (e) {
      logger.warn('dispatch: failed to fetch spec_url', {
        specUrl, error: e instanceof Error ? e.message : String(e),
      })
      return c.json({ error: 'failed to fetch spec_url' }, 502)
    }

    const slug = extractSlug(specBody) || `dispatch-${Date.now()}`

    // 3. Create skill resource. resources.add accepts (name, type, config?, notes?, status?).
    const skill = await resources.add(
      `skill/${slug}-${Date.now().toString(36)}`,
      'skill',
      { content: specBody, source_url: specUrl },
    )

    // 4. Link skill → project (canonical 'parent' linkType, matches existing graph topology).
    await resources.createLinkById(skill.id, projectResource.id, 'parent')

    // 5. Insert active process scoped to project. processes.init() is the
    //    canonical insert helper (legacy method name predates "create" coinage).
    const processId = await processes.init({
      name: slug,
      skillResourceId: skill.id,
      projectId: projectResource.id,
      status: 'active',
    })

    // 6. Breadcrumb event so observability surfaces register the dispatch.
    //    `process_born_from` is the closest match in AgentEventSource's union
    //    for "this process was created by an external dispatcher".
    try {
      await events.insertAgentEvent({
        processId,
        processName: slug,
        resourceId: skill.id,
        source: 'process_born_from',
        payload: { spec_url: specUrl, slug },
      })
    } catch (e) {
      // Non-fatal — event recording shouldn't fail the dispatch.
      logger.warn('dispatch: failed to insert breadcrumb event', {
        processId, error: e instanceof Error ? e.message : String(e),
      })
    }

    // 7. Same-origin URL focused on the new skill — chat iframe inherits Supabase session.
    //    `embed=1` strips the surrounding chrome (sidebar, top bar, project
    //    switcher, theme/dials toggles) since this URL is rendered inside the
    //    chat's artifact iframe — duplicate top-bar UI inside the iframe is
    //    visually noisy.
    const url = `/p/${encodeURIComponent(projectName)}?layout=terrain&focusType=skill&focusId=${skill.id}&embed=1`
    logger.info('dispatch: created skill + active process', {
      userId, processId, skillId: skill.id, slug,
    })
    return c.json({ url, processId, skillId: skill.id, processName: slug, specUrl })
  })

  return router as unknown as Hono
}
