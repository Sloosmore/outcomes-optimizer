import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN_PATH = path.join(os.homedir(), '.config', 'duoidal', 'token.json')

function extractSub(token: string, checkExpiry: boolean): string | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf-8')
    const claims = JSON.parse(decoded)
    if (checkExpiry && typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) return null
    if (claims.sub && typeof claims.sub === 'string') return claims.sub
    return null
  } catch {
    return null
  }
}

/**
 * Parse JWT and return sub claim. Returns null if token is expired or invalid.
 * Used by adapter-factory.ts for auth flows where expiry matters.
 */
export function parseJwtSub(token: string): string | null {
  return extractSub(token, true)
}

/**
 * Parse JWT and return sub claim WITHOUT checking expiry.
 * Used for project resolution where sub is a stable identifier, not a credential.
 */
export function parseJwtSubUnchecked(token: string): string | null {
  return extractSub(token, false)
}

/**
 * Read token.json from ~/.config/duoidal/token.json.
 * Returns null if file doesn't exist or is invalid JSON.
 */
export function readLocalToken(): { access_token?: string; refresh_token?: string; expires_at?: number; [key: string]: unknown } | null {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Write token.json to ~/.config/duoidal/token.json atomically.
 * Creates the directory if it doesn't exist.
 */
export function writeLocalToken(data: { access_token: string; refresh_token?: string; expires_at?: number }): void {
  const dir = path.dirname(TOKEN_PATH)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = `${TOKEN_PATH}.tmp.${process.pid}`
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmpPath, TOKEN_PATH)
}

/**
 * Returns true if the token's exp claim is in the past or within the given buffer.
 */
export function isTokenExpired(token: string, bufferSeconds = 60): boolean {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return true
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    // Tokens without exp are non-rotating machine tokens; treat as never expired.
    if (typeof claims.exp !== 'number') return false
    return claims.exp < Math.floor(Date.now() / 1000) + bufferSeconds
  } catch {
    return true
  }
}

/**
 * Convenience: read local token and extract sub (with expiry check).
 * Returns null if no token or token is expired/invalid.
 */
export function getLocalSub(): string | null {
  if (process.env.DUOIDAL_TOKEN) {
    return parseJwtSub(process.env.DUOIDAL_TOKEN)
  }
  const token = readLocalToken()
  if (token?.access_token) {
    return parseJwtSub(token.access_token)
  }
  return null
}

/**
 * Convenience: read local token and extract sub WITHOUT expiry check.
 * Used for project resolution where sub is a stable identifier, not a credential.
 * Returns null only if no token exists or JWT is malformed.
 */
export function getLocalSubUnchecked(): string | null {
  if (process.env.DUOIDAL_TOKEN) {
    return parseJwtSubUnchecked(process.env.DUOIDAL_TOKEN)
  }
  const token = readLocalToken()
  if (token?.access_token) {
    return parseJwtSubUnchecked(token.access_token)
  }
  return null
}
