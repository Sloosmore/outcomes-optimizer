import { Hono } from 'hono'
import { AccessToken } from '../adapters/realtime/livekit-adapter.js'
import { supabase } from '../lib/supabase.js'
import { getServices } from '../lib/services.js'

export const healthRouter = new Hono()

healthRouter.get('/', async (c) => {
  let dbStatus: 'ok' | 'error' = 'error'
  // First: check compose postgres via getSqlClient (succeeds when DATABASE_URL is set)
  if (process.env['DATABASE_URL']) {
    try {
      const { sql } = getServices()
      // eslint-disable-next-line no-restricted-syntax -- health check requires raw SELECT 1; no service method exists for a bare connectivity probe
      await sql`SELECT 1`
      dbStatus = 'ok'
    } catch {
      // compose db unreachable — fall through to supabase check
    }
  }
  // Fallback: check Supabase connectivity
  if (dbStatus === 'error') {
    try {
      await supabase.from('chats').select('id').limit(1)
      dbStatus = 'ok'
    } catch {
      // db unreachable
    }
  }

  const sshStatus: 'ok' | 'error' = process.env['OPENCLAW_HOST'] ? 'ok' : 'error'

  let livekitStatus: 'ok' | 'error' = 'error'
  try {
    const apiKey = process.env['LIVEKIT_API_KEY']
    const apiSecret = process.env['LIVEKIT_API_SECRET']
    if (apiKey && apiSecret) {
      const at = new AccessToken(apiKey, apiSecret, { identity: 'health-check' })
      at.addGrant({ roomJoin: true, room: 'health' })
      await at.toJwt()
      livekitStatus = 'ok'
    }
  } catch {
    // livekit not configured or token generation failed
  }

  return c.json({ db: dbStatus, ssh: sshStatus, livekit: livekitStatus, version: '1.0.0' })
})
