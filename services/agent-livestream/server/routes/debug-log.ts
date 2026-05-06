import { Hono } from 'hono'
import { createLogger } from '@skill-networks/logger'

// Remote-log sink for the LiveKit Cloud worker. The worker container has no
// accessible stdout (lk agent logs only emits during build/deploy), so we
// pipe critical-path events here and read them in Vercel logs.
//
// Auth: shared secret in X-Debug-Log-Secret. Same secret as RESEARCH_INTERNAL_SECRET
// to avoid adding another env var. If the secret is unset, the route accepts
// any request — that's intentional for emergency-debug situations where
// rotating secrets is in flight; remove this fallback once stable.
const logger = createLogger('agent-livestream:worker-debug')

export const debugLogRouter = new Hono()

debugLogRouter.post('/', async (c) => {
  const secret = process.env['RESEARCH_INTERNAL_SECRET']
  // In production, refuse all requests if the secret is not configured.
  // The open fallback is only valid in non-production environments where
  // secrets may not be provisioned.
  if (!secret && process.env['NODE_ENV'] === 'production') {
    return c.json({ error: 'forbidden' }, 403)
  }
  if (secret) {
    const presented = c.req.header('X-Debug-Log-Secret')
    if (presented !== secret) return c.json({ error: 'forbidden' }, 403)
  }
  let body: unknown = null
  try { body = await c.req.json() } catch { body = await c.req.text() }
  logger.info('[voice-agent-debug]', { receivedAt: new Date().toISOString(), payload: body })
  return c.json({ ok: true })
})
