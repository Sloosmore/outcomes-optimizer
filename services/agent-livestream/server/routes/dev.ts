import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseServiceKey, getSupabaseUrl } from '@skill-networks/database/constants'

export const devRouter = new Hono()

// Dev-only route — only accessible when NODE_ENV is explicitly 'development'
devRouter.get('/auth-state', async (c) => {
  if (process.env['NODE_ENV'] !== 'development') {
    return c.json({ error: 'Not found' }, 404)
  }

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing Authorization header' }, 401)
  }
  const token = authHeader.slice(7)

  // Decode without full verification (dev only) — just extract claims
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return c.json({ error: 'Malformed token' }, 401)
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
      sub?: string
      email?: string
      exp?: number
      iat?: number
      role?: string
    }
    return c.json({
      sub: payload.sub,
      email: payload.email,
      exp: payload.exp,
      iat: payload.iat,
      role: payload.role,
    })
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})

// Dev-only route — reset a user's password by email (only accessible in development)
devRouter.post('/reset-password', async (c) => {
  if (process.env['NODE_ENV'] !== 'development') {
    return c.json({ error: 'Not found' }, 404)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { email, newPassword } = body as { email?: string; newPassword?: string }

  if (!email || !newPassword) {
    return c.json({ error: 'Missing required fields: email, newPassword' }, 400)
  }

  // Dev-only route; the service key must be present for admin operations.
  // getSupabaseServiceKey() throws a clear error if unset — surface that to the caller.
  let serviceKey: string
  try {
    serviceKey = getSupabaseServiceKey()
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Service key not configured' }, 500)
  }
  const adminClient = createClient(getSupabaseUrl(), serviceKey)

  // Find the user by email — paginate through all users
  let user: { id: string } | undefined
  let page = 1
  while (!user) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 100 })
    if (error) return c.json({ error: `Failed to list users: ${error.message}` }, 500)
    user = data.users.find((u) => u.email === email)
    if (data.users.length < 100) break
    page++
  }
  if (!user) {
    return c.json({ error: `No user found with email: ${email}` }, 404)
  }

  // Update the user's password
  const { error: updateError } = await adminClient.auth.admin.updateUserById(user.id, {
    password: newPassword,
  })
  if (updateError) {
    return c.json({ error: `Failed to update password: ${updateError.message}` }, 500)
  }

  return c.json({ ok: true })
})
