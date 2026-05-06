/**
 * JWT decode helpers — zero-dependency, no signature verification.
 * Used to extract claims (sub, exp) from Supabase access tokens.
 */

export interface JwtPayload {
  sub?: string
  exp?: number
  iat?: number
  email?: string
  [key: string]: unknown
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Sentinel error thrown when a JWT's `sub` claim is not a UUID.
 *
 * Real Supabase user JWTs carry a UUID `sub`. A non-UUID sub indicates the
 * token is a stale test fixture (e.g. `"user-refresh-789"`) that leaked from
 * a vitest run into a real token file, or a hand-crafted/malformed token
 * making it past decode. Catching this at the auth boundary keeps the bad
 * value out of downstream Postgres calls (where it would crash with
 * `invalid input syntax for type uuid`).
 *
 * Callers may catch this to surface "your token is broken; re-auth" messaging.
 */
export class NonUuidSubError extends Error {
  readonly sub: string | undefined
  constructor(sub: unknown) {
    const subStr = typeof sub === 'string' ? sub : (sub === undefined ? '<missing>' : JSON.stringify(sub))
    super(
      `JWT sub claim is not a UUID (got: ${JSON.stringify(subStr)}). ` +
      `This is almost certainly a stale test fixture, not a real auth token. ` +
      `Run: duoidal auth login`
    )
    this.name = 'NonUuidSubError'
    this.sub = typeof sub === 'string' ? sub : undefined
  }
}

/**
 * Decode a JWT payload (no signature verification).
 * Throws if the token is malformed.
 */
export function decodeJwt(token: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('Invalid JWT: expected 3 parts')
  }
  try {
    // base64url → base64 → buffer → JSON
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(base64, 'base64').toString('utf-8')
    return JSON.parse(json) as JwtPayload
  } catch {
    throw new Error('Invalid JWT: payload is not valid base64url JSON')
  }
}

/**
 * Extract the `sub` claim (user ID) from a JWT, asserting it is a UUID.
 *
 * Throws `NonUuidSubError` for any non-UUID sub (including missing/empty).
 * This single check defends every auth flow path — `whoami`, `requireAuth`,
 * token refresh, etc. — from leaking a fixture-style sub into downstream
 * Postgres queries that require a UUID.
 *
 * If a future call site genuinely needs to read a non-UUID sub (e.g. a
 * service-account token), expose a separate helper rather than relaxing
 * this one.
 */
export function getSubClaim(token: string): string {
  const payload = decodeJwt(token)
  if (typeof payload.sub !== 'string' || !payload.sub || !UUID_RE.test(payload.sub)) {
    throw new NonUuidSubError(payload.sub)
  }
  return payload.sub
}

/** Extract the `exp` claim as seconds-since-epoch. Returns undefined if absent. */
export function getExpiresAt(token: string): number | undefined {
  const payload = decodeJwt(token)
  return typeof payload.exp === 'number' ? payload.exp : undefined
}
