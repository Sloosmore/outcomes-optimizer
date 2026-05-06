import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import { getServices } from '../lib/services.js'
import { getSqlClient } from '@skill-networks/database/client'
import { AuthDbService } from '@duoidal/auth/services'
import { createRateLimiter } from '../middleware/rate-limit.js'
import { createLogger } from '@skill-networks/logger'
import { executeAction } from '@skill-networks/database/actions'

const logger = createLogger('agent-livestream:auth')

const rateLimiter = createRateLimiter({ max: 10, windowMs: 60_000 })
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseReturnTo(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  if (!raw.startsWith('/') || raw.startsWith('//')) return ''
  // Strip fragment. A failed verify leaves `#error=otp_expired&...` on the URL;
  // forwarding it back as redirect_to makes the next (valid) magic link land on
  // a URL that looks identical to an expired one.
  const hashIdx = raw.indexOf('#')
  return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
}

export const authRouter = new Hono()

authRouter.post('/check-email', rateLimiter, async (c) => {
  let email: string | undefined
  let returnTo: string = ''
  try {
    const body = await c.req.json<{ email?: string; returnTo?: string }>()
    email = typeof body?.email === 'string' ? body.email.trim() : undefined
    returnTo = parseReturnTo(body?.returnTo)
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (!email) return c.json({ error: 'email is required' }, 400)

  if (!EMAIL_RE.test(email)) return c.json({ error: 'Invalid email format' }, 400)

  // Pure existence check via direct DB query — no OTP sent, no rate limit consumed.
  // signInWithOtp({ shouldCreateUser: false }) burns the 60-second per-email OTP rate
  // limit even when the user doesn't exist (no email is sent but the slot is consumed).
  // The GoTrue admin API ?email= param uses fuzzy/substring matching, not exact.
  // Querying auth.users directly is exact-match and completely rate-limit-free.
  const authDb = new AuthDbService(getSqlClient())
  const existingUser = await authDb.findUserByEmail(email)

  if (!existingUser) {
    return c.json({ exists: false })
  }

  // User exists — send magic link so they can sign in without needing an access code.
  const siteUrl = process.env['VERCEL_ENV'] === 'production'
    ? `https://${process.env['VERCEL_PROJECT_PRODUCTION_URL']}`
    : process.env['VERCEL_URL']
      ? `https://${process.env['VERCEL_URL']}`
      : (c.req.header('origin') ?? '')

  const { error: otpError } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      ...(siteUrl ? { emailRedirectTo: siteUrl + returnTo } : {}),
    },
  })

  if (otpError) {
    logger.error('Magic link send failed for returning user', { error: otpError.message, email })
    return c.json({ error: 'Failed to send magic link' }, 500)
  }

  return c.json({ exists: true })
})

authRouter.post('/validate-code', rateLimiter, async (c) => {
  let code: string | undefined
  let email: string | undefined
  try {
    const body = await c.req.json<{ code?: string; email?: string }>()
    code = typeof body?.code === 'string' ? body.code.trim() : undefined
    email = typeof body?.email === 'string' ? body.email.trim() : undefined
  } catch {
    return c.json({ valid: false })
  }
  if (!code) return c.json({ valid: false })

  // Look up access code by config->>'code' field (underscore type) OR by name (hyphen type)
  // The criterion inserts access codes with config.code=<value> and type='access_code'
  const sql = getSqlClient()
  let codeResource: { id: string; status: string } | null = null
  try {
    // eslint-disable-next-line no-restricted-syntax -- access_code lookup uses resources table directly; no ResourcesService method exists for this query shape (config->>'code' JSON field lookup)
    const rows = await sql<[{ id: string; status: string }]>`
      SELECT id, status FROM resources
      WHERE (
        (type = 'access_code' AND config->>'code' = ${code})
        OR (type = 'access-code' AND name = ${code})
      )
      AND status = 'active'
      LIMIT 1
    `
    codeResource = rows[0] ?? null
  } catch {
    return c.json({ valid: false })
  }

  const isValid = codeResource?.status === 'active'

  // If email provided AND code is valid: provision the user
  if (email && isValid) {
    if (!EMAIL_RE.test(email)) {
      return c.json({ valid: true, error: 'Invalid email format' }, 200)
    }

    let didProvision = false
    try {
      let authUserId: string | undefined

      // Use a unique random password — users sign in via magic link, not password.
      // A random value per user prevents credential sharing across accounts.
      const tempPassword = randomBytes(32).toString('hex')

      // Try admin API first (works in newer Supabase)
      const { data: adminData, error: adminErr } = await supabase.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
      }).catch(() => ({ data: null, error: new Error('admin API unavailable') }))

      if (!adminErr && adminData?.user?.id) {
        authUserId = adminData.user.id
      } else {
        // Admin API failed — fall back to direct SQL upsert for local dev Supabase
        // Insert auth user with confirmed status so password sign-in works immediately
        const upserted = await new AuthDbService(getSqlClient()).upsertUser(email)
        authUserId = upserted?.id
      }

      if (authUserId) {
        await executeAction('provision_user', { authUserId, email }, supabase)
        didProvision = true
      }
    } catch (provisionErr) {
      logger.warn('validate-code provision failed', {
        error: provisionErr instanceof Error ? provisionErr.message : String(provisionErr),
      })
      // Don't fail — code was valid, user creation is best-effort
    }
    return c.json({ valid: true, provisioned: didProvision }, 200)
  }

  return c.json({ valid: isValid })
})

authRouter.post('/magic-link', rateLimiter, async (c) => {
  let email: string | undefined
  let code: string | undefined
  let returnTo: string = ''
  try {
    const body = await c.req.json<{ email?: string; code?: string; returnTo?: string }>()
    email = typeof body?.email === 'string' ? body.email.trim() : undefined
    code = typeof body?.code === 'string' ? body.code.trim() : undefined
    returnTo = parseReturnTo(body?.returnTo)
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (!email || !code) {
    return c.json({ error: 'email and code are required' }, 400)
  }

  if (!EMAIL_RE.test(email)) {
    return c.json({ error: 'Invalid email format' }, 400)
  }

  // Read-only pre-check: does the code exist and is it active?
  // This is advisory only — it saves an OTP call for obviously invalid codes.
  // The real atomicity guarantee comes from redeem_access_code (uses SELECT ... FOR UPDATE),
  // which is called below after provision_user. Under concurrent requests, two callers can
  // both pass this check and both send magic links, but only one will win the DB-level lock
  // in redeem_access_code. The losing caller's redeem error is caught and logged as a warning.
  const { resources } = getServices()
  try {
    const resource = await resources.findByNameAndType(code, 'access-code')
    if (!resource || resource.status !== 'active') {
      return c.json({ error: 'Invalid or expired access code' }, 400)
    }
  } catch {
    return c.json({ error: 'Database error validating code' }, 500)
  }

  const siteUrl = process.env['VERCEL_ENV'] === 'production'
    ? `https://${process.env['VERCEL_PROJECT_PRODUCTION_URL']}`
    : process.env['VERCEL_URL']
      ? `https://${process.env['VERCEL_URL']}`
      : (c.req.header('origin') ?? '')

  // Single OTP call: creates the user if needed AND sends the magic link email.
  // Avoid generateLink() before this — it internally generates an OTP token that counts
  // against the same 60-second per-email rate limit, causing rate limit errors for new users.
  const { error: otpError } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      ...(siteUrl ? { emailRedirectTo: siteUrl + returnTo } : {}),
    },
  })

  if (otpError) {
    logger.error('Magic link email send failed', { error: otpError.message, email })
    return c.json({ error: 'Failed to send magic link email' }, 500)
  }

  // Provision user resource and atomically redeem the access code.
  // redeem_access_code flips code status to 'used' and creates the redeemed_by link in one transaction.
  try {
    const authUser = await new AuthDbService(getSqlClient()).findUserByEmail(email)
    const authUuid = authUser?.id
    if (authUuid) {
      const result = await executeAction('provision_user', { authUserId: authUuid, email }, supabase)
      if (result.userResourceId) {
        try {
          await executeAction('redeem_access_code', { code, userId: result.userResourceId as string }, supabase)
        } catch (redeemErr) {
          // Code may have been claimed by a concurrent request — log but don't fail the response.
          // The user already received their magic link.
          logger.warn('redeem_access_code failed (possible concurrent redemption)', { error: redeemErr instanceof Error ? redeemErr.message : String(redeemErr) })
        }
      }
    }
  } catch (provisionErr) {
    logger.error('Failed to provision user', { error: provisionErr instanceof Error ? provisionErr.message : String(provisionErr) })
  }

  return c.json({ success: true }, 200)
})
