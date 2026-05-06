import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose'
import { createLogger } from '@skill-networks/logger'
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../types.js'

const logger = createLogger('agent-livestream:jwt')

// Reads raw env (rather than getSupabaseUrl()) because the "explicitly set" signal
// decides between JWKS and HS256 fallback. The helper's prod-URL fallback would
// silently force JWKS and break the HS256 local-dev path.
const supabaseUrl = process.env['SUPABASE_URL'] ?? ''
const jwtSecret = process.env['SUPABASE_JWT_SECRET'] ?? ''

const useJwks = supabaseUrl && !jwtSecret

const jwks = useJwks
  ? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
  : null

if (jwks) {
  logger.info('JWT middleware using JWKS (jose createRemoteJWKSet)')
} else if (jwtSecret) {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('FATAL: SUPABASE_URL required in production for JWKS verification. Set SUPABASE_URL or use JWKS.')
  }
  logger.info('JWT middleware using HS256 secret (SUPABASE_JWT_SECRET set — local dev only)')
} else if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) {
  logger.warn('JWT middleware: no verification method configured (test environment — requests will return 500)')
} else {
  throw new Error('FATAL: No JWT verification method available. Set SUPABASE_URL (for JWKS) or SUPABASE_JWT_SECRET (for HS256).')
}

const secretForHS256 = jwtSecret ? new TextEncoder().encode(jwtSecret) : null

/**
 * Verify a raw Supabase Bearer token and return its payload, or null if invalid.
 * Reuses the module-level JWKS/HS256 verifiers to avoid redundant configuration.
 * Returns null rather than throwing so callers can treat verification as best-effort.
 */
export async function verifyBearerToken(token: string): Promise<JWTPayload | null> {
  try {
    if (jwks) {
      const result = await jwtVerify(token, jwks, {
        algorithms: ['RS256', 'ES256'],
        audience: 'authenticated',
        issuer: `${supabaseUrl}/auth/v1`,
      })
      return result.payload
    } else if (secretForHS256) {
      const result = await jwtVerify(token, secretForHS256, {
        algorithms: ['HS256'],
        audience: 'authenticated',
      })
      return result.payload
    }
  } catch {
    // Invalid/expired/unverifiable token — return null (caller treats as best-effort)
  }
  return null
}

export const jwtMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  // Internal bypass: voice-agent calls the BFF research endpoint from the same container.
  // Only active when RESEARCH_INTERNAL_SECRET is set (non-empty) and the request carries it.
  // Set a synthetic payload so downstream handlers that read jwtPayload get a defined value.
  const internalSecret = process.env['RESEARCH_INTERNAL_SECRET']
  if (internalSecret && c.req.header('X-Research-Secret') === internalSecret) {
    c.set('jwtPayload', { sub: 'internal-voice-agent', role: 'internal' } as JWTPayload)
    await next()
    return
  }

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Authentication required' }, 401)
  }

  const token = authHeader.slice(7)

  let payload: JWTPayload
  try {
    if (jwks) {
      const result = await jwtVerify(token, jwks, {
        algorithms: ['RS256', 'ES256'],
        audience: 'authenticated',
        issuer: `${supabaseUrl}/auth/v1`,
      })
      payload = result.payload
    } else if (secretForHS256) {
      const result = await jwtVerify(token, secretForHS256, {
        algorithms: ['HS256'],
        audience: 'authenticated',
      })
      payload = result.payload
    } else {
      return c.json({ error: 'Server misconfigured — no JWT verification method' }, 500)
    }
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) {
      logger.warn('JWT expired', { path: c.req.path })
      return c.json({ error: 'Token expired' }, 401)
    }
    logger.warn('JWT verification failed', {
      path: c.req.path,
      error: e instanceof Error ? e.message : String(e),
    })
    return c.json({ error: 'Invalid token' }, 401)
  }

  c.set('jwtPayload', payload)
  await next()
}
