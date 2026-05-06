/**
 * Mint a Supabase-compatible JWT for use in rpc-matrix tests.
 * Uses Node.js crypto module only — no external JWT library.
 */

import { createHmac } from 'node:crypto'

const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'

function base64urlEncode(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export interface JwtPayload {
  sub: string
  email: string
  role: string
  iss: string
  exp: number
  iat: number
}

export function mintJwt(params: { sub: string; email: string }): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: JwtPayload = {
    sub: params.sub,
    email: params.email,
    role: 'authenticated',
    iss: 'supabase-demo',
    iat: now - 10, // -10s leeway for clock skew between host and Supabase container
    exp: now + 3600, // 1 hour
  }

  const encodedHeader = base64urlEncode(JSON.stringify(header))
  const encodedPayload = base64urlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const signature = createHmac('sha256', LOCAL_JWT_SECRET)
    .update(signingInput)
    .digest()

  const encodedSignature = base64urlEncode(signature)
  return `${signingInput}.${encodedSignature}`
}
