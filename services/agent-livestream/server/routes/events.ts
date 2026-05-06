import { Hono } from 'hono'
import { z } from 'zod'
import type { JWTPayload } from 'jose'
import { createLogger } from '@skill-networks/logger'
import { supabase } from '../lib/supabase.js'
import { ForbiddenError, authorizeProjectAccess, startProjectEventStream } from '../lib/event-stream-service.js'

const logger = createLogger('agent-livestream:sse-route')

type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}

export const eventsRouter = new Hono<Env>()

/**
 * GET /api/events?projectId=<uuid>
 *
 * Returns a Server-Sent Events stream scoped to the given project.
 * Auth path: JWT middleware (app.ts) → this handler → authorizeProjectAccess (ProjectScopeService).
 * No inline auth logic — authorization is delegated to event-stream-service.
 *
 * Responses:
 *   401 — missing or invalid JWT (handled by jwtMiddleware before this handler reaches)
 *   400 — projectId param missing or not a UUID
 *   403 — valid JWT but user is not a member of the requested project
 *   200 text/event-stream — authorized, stream open
 */
eventsRouter.get('/', async (c) => {
  const rawProjectId = c.req.query('projectId')
  if (!rawProjectId) {
    return c.json({ error: 'projectId query parameter is required' }, 400)
  }
  if (!z.string().uuid().safeParse(rawProjectId).success) {
    return c.json({ error: 'Invalid projectId — must be a UUID' }, 400)
  }

  const payload = c.get('jwtPayload') as JWTPayload | undefined
  const userId = payload?.sub
  if (!userId) {
    return c.json({ error: 'Invalid token: missing sub claim' }, 401)
  }

  // Authorization check BEFORE opening the SSE stream so we can return 403 JSON.
  // Delegates to ProjectScopeService via authorizeProjectAccess — no inline auth logic here.
  try {
    await authorizeProjectAccess({ projectId: rawProjectId, userId })
  } catch (err: unknown) {
    if (err instanceof ForbiddenError) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    logger.error('Authorization check failed', { projectId: rawProjectId, error: err })
    return c.json({ error: 'Internal server error' }, 500)
  }

  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no')

  let cleanup: (() => void) | undefined

  return c.body(
    new ReadableStream({
      start(controller) {
        cleanup = startProjectEventStream({
          projectId: rawProjectId,
          supabaseClient: supabase,
          controller,
        })
      },
      cancel() {
        cleanup?.()
      },
    }),
    200,
  )
})
