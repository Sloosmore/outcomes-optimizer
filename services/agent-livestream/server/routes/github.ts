import { Hono } from 'hono'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import type { Env } from '../types.js'
import { supabase } from '../lib/supabase.js'
import { executeAction } from '@skill-networks/database/actions'
import { getServices } from '../lib/services.js'

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

// In-memory store for CLI relay: state token → installation_id
// Entries expire after 10 minutes to prevent unbounded growth
const pendingInstalls = new Map<string, { installationId: string; expiresAt: number }>()
const RELAY_TTL_MS = 10 * 60 * 1000

function isOpaqueToken(state: string): boolean {
  // Opaque CLI tokens are 32 hex chars; JWTs have two dots
  return !state.includes('.')
}

// Reads raw env (rather than getSupabaseUrl()) to mirror middleware/jwt.ts:
// the "explicitly set" signal decides between JWKS and HS256 fallback.
const supabaseUrl = process.env['SUPABASE_URL'] ?? ''
const jwtSecret = process.env['SUPABASE_JWT_SECRET'] ?? ''
const jwks = supabaseUrl
  ? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
  : null
const secretForHS256 = jwtSecret ? new TextEncoder().encode(jwtSecret) : null

async function verifyJwt(token: string): Promise<JWTPayload | null> {
  try {
    if (jwks) {
      const { payload } = await jwtVerify(token, jwks, { algorithms: ['RS256', 'ES256'], audience: 'authenticated' })
      return payload
    }
    if (secretForHS256) {
      const { payload } = await jwtVerify(token, secretForHS256, { algorithms: ['HS256'], audience: 'authenticated' })
      return payload
    }
    return null
  } catch {
    return null
  }
}

// ── Unauthenticated: GitHub App OAuth callback ────────────────────────────────
// Handles: GET /github/callback?code=CODE&installation_id=ID&setup_action=install&state=JWT
// The state param MUST be a valid signed JWT — we verify the signature to prevent
// an attacker from forging a state with a victim's sub claim.
export const githubCallbackRouter = new Hono()

githubCallbackRouter.get('/callback', async (c) => {
  const installation_id = c.req.query('installation_id')
  const state = c.req.query('state')

  const installationId = installation_id ?? ''
  if (!installationId || !/^\d+$/.test(installationId)) {
    return c.redirect('/?github=error')
  }

  // ── CLI relay path: opaque state token ───────────────────────────────────────
  // CLI generates a random hex token, passes it as ?state=<token> in the install URL.
  // GitHub passes it through to the Setup URL. We store the mapping here and the
  // CLI polls /github/poll?state=<token> to retrieve it.
  if (state && isOpaqueToken(state)) {
    pendingInstalls.set(state, { installationId, expiresAt: Date.now() + RELAY_TTL_MS })
    return c.html('<html><body><h2>GitHub connected! You can close this tab.</h2></body></html>')
  }

  // ── Web app path: JWT in state ────────────────────────────────────────────────
  const code = c.req.query('code')
  if (!code) {
    return c.redirect('/?github=error')
  }

  const clientId = process.env['GITHUB_APP_CLIENT_ID']
  const clientSecret = process.env['GITHUB_APP_CLIENT_SECRET']

  if (!clientId || !clientSecret) {
    return c.redirect('/?github=error')
  }

  try {
    if (!state) {
      return c.redirect('/?github=error')
    }

    // Verify the JWT signature on state BEFORE exchanging the code.
    // The OAuth code is one-time-use; consuming it against GitHub before validating
    // the state allows a CSRF attacker to permanently consume a victim's code.
    const claims = await verifyJwt(state)
    if (!claims?.sub) {
      return c.redirect('/?github=error')
    }

    // Exchange code for access token
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })

    if (!tokenRes.ok) {
      return c.redirect('/?github=error')
    }

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
    if (!tokenData.access_token) {
      return c.redirect('/?github=error')
    }

    // Look up user resource by auth uid
    const { resources } = getServices()
    const userRes = await resources.findByTypeAndName('user', `user:${claims.sub}`)

    if (!userRes) {
      return c.redirect('/?github=error')
    }

    await executeAction('store_github_installation', { userResourceId: userRes.id, installationId }, supabase)

    return c.redirect('/?github=connected')
  } catch {
    return c.redirect('/?github=error')
  }
})

// ── CLI relay poll ────────────────────────────────────────────────────────────
// CLI polls this endpoint after opening the browser. Returns installation_id when ready.
githubCallbackRouter.get('/poll', (c) => {
  const state = c.req.query('state')
  if (!state) return c.json({ error: 'missing state' }, 400)

  // Evict expired entries
  const now = Date.now()
  for (const [k, v] of pendingInstalls) {
    if (v.expiresAt < now) pendingInstalls.delete(k)
  }

  const entry = pendingInstalls.get(state)
  if (!entry) return c.json({ pending: true })

  pendingInstalls.delete(state)
  return c.json({ installationId: entry.installationId })
})

// ── Authenticated: GitHub status check ───────────────────────────────────────
// Handles: GET /api/github/status
export const githubRouter = new Hono<Env>()

githubRouter.get('/status', async (c) => {
  const payload = c.get('jwtPayload')
  const sub = payload.sub as string

  const { resources } = getServices()

  // Find user resource by name convention: user:<auth_uid>
  const userRes = await resources.findByTypeAndName('user', `user:${sub}`)

  if (!userRes) {
    return c.json({ connected: false })
  }

  const userResourceId = userRes.id

  // Check for github_app link
  const githubLinks = await resources.listLinksToIdFull({ toId: userResourceId, linkType: 'github_app' })

  if (!githubLinks?.length) {
    return c.json({ connected: false })
  }

  const link = githubLinks[0] as unknown as Record<string, unknown>
  const installationId: string = (link['installation_id'] as string | undefined)
    ?? ((link['config'] as Record<string, unknown> | undefined)?.['installation_id'] as string | undefined)
    ?? (link['from_id'] as string | undefined)
    ?? 'unknown'

  return c.json({ connected: true, installationId })
})
