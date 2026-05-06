import { describe, it, expect } from 'vitest'
import { decodeJwt, getSubClaim, getExpiresAt, NonUuidSubError } from './token.js'

const REAL_UUID = '25337a89-cde3-4808-be8a-a576fb46a307'

// A real JWT structure: header.payload.sig
// Payload: { "sub": "user-123", "exp": 9999999999, "email": "test@example.com" }
function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fakesig`
}

describe('decodeJwt', () => {
  it('decodes a valid JWT payload', () => {
    const jwt = makeJwt({ sub: 'user-123', exp: 9999 })
    const payload = decodeJwt(jwt)
    expect(payload.sub).toBe('user-123')
    expect(payload.exp).toBe(9999)
  })

  it('throws on malformed JWT (wrong number of parts)', () => {
    expect(() => decodeJwt('invalid')).toThrow('Invalid JWT')
  })

  it('throws on non-base64url payload', () => {
    expect(() => decodeJwt('hdr.!!!.sig')).toThrow()
  })
})

describe('getSubClaim', () => {
  it('returns sub from a JWT whose sub is a UUID', () => {
    const jwt = makeJwt({ sub: REAL_UUID })
    expect(getSubClaim(jwt)).toBe(REAL_UUID)
  })

  it('throws NonUuidSubError when sub is missing', () => {
    const jwt = makeJwt({ exp: 9999 })
    expect(() => getSubClaim(jwt)).toThrow(NonUuidSubError)
    expect(() => getSubClaim(jwt)).toThrow(/not a UUID/)
  })

  it('throws NonUuidSubError on the exact fixture-token string from PR #940', () => {
    // The placeholder sub that leaked from a vitest writeFileSync into real
    // token files prior to PR #940. Real Supabase JWTs carry a UUID sub; this
    // string only appears in test fixtures. Catching it at decode time keeps
    // it from reaching downstream Postgres calls that crash with
    // "invalid input syntax for type uuid".
    const jwt = makeJwt({ sub: 'user-refresh-789', exp: 9999 })
    expect(() => getSubClaim(jwt)).toThrow(NonUuidSubError)
    expect(() => getSubClaim(jwt)).toThrow(/duoidal auth login/)
  })

  it('throws NonUuidSubError when sub is a non-UUID string', () => {
    const jwt = makeJwt({ sub: 'user-abc' })
    expect(() => getSubClaim(jwt)).toThrow(NonUuidSubError)
  })

  it('NonUuidSubError exposes the offending sub for callers that want it', () => {
    const jwt = makeJwt({ sub: 'user-refresh-789' })
    try {
      getSubClaim(jwt)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(NonUuidSubError)
      expect((err as NonUuidSubError).sub).toBe('user-refresh-789')
    }
  })
})

describe('getExpiresAt', () => {
  it('returns exp from valid JWT', () => {
    const jwt = makeJwt({ sub: 'x', exp: 1234567890 })
    expect(getExpiresAt(jwt)).toBe(1234567890)
  })

  it('returns undefined when exp absent', () => {
    const jwt = makeJwt({ sub: 'x' })
    expect(getExpiresAt(jwt)).toBeUndefined()
  })
})
