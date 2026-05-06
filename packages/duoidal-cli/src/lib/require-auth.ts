import { readToken, writeToken } from './config.js'
import { getSubClaim, getExpiresAt, NonUuidSubError } from '@duoidal/auth'
import { getSupabaseUrl, getSupabaseAnonKey } from './helpers.js'

// Type for the refreshSession dependency injection
export type RefreshSessionFn = (
  url: string,
  anonKey: string,
  refreshToken: string,
  factory?: unknown
) => Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>

// Default refreshSession implementation loaded lazily to avoid rootDir violations
async function defaultRefreshSession(
  url: string,
  anonKey: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  // @ts-ignore — tsup bundles @duoidal/auth via noExternal; TS rootDir prevents static resolution
  const mod = await import('@duoidal/auth/adapters') as { refreshSession: RefreshSessionFn }
  return mod.refreshSession(url, anonKey, refreshToken)
}

export interface RequireAuthOptions {
  refreshSessionFn?: RefreshSessionFn
}

/**
 * Ensure the user is authenticated. Reads the stored token, refreshes via Supabase
 * if expired (when a refresh_token is available), and returns sub + tokens.
 * Exits with a helpful message if not logged in or refresh fails.
 *
 * If DUOIDAL_TOKEN env var is set, parse JWT from env, skip token.json, validate sub + expiry,
 * and return early with an empty refreshToken. No refresh is attempted for env tokens.
 */
export async function requireAuth(opts?: RequireAuthOptions): Promise<{ sub: string; accessToken: string; refreshToken: string }> {
  // DUOIDAL_TOKEN bypass: parse JWT from env, skip token.json, no refresh
  const envToken = process.env['DUOIDAL_TOKEN']
  if (envToken) {
    let sub: string
    try {
      sub = getSubClaim(envToken)
    } catch (err) {
      // Distinguish "non-UUID sub" (likely a fixture token) from "missing/malformed"
      // so the operator's next move is unambiguous.
      if (err instanceof NonUuidSubError) {
        console.error(`DUOIDAL_TOKEN: ${err.message}`)
      } else {
        console.error('DUOIDAL_TOKEN: invalid token — no sub claim')
      }
      process.exit(1)
    }

    const exp = getExpiresAt(envToken)
    if (exp !== undefined) {
      const now = Math.floor(Date.now() / 1000)
      if (exp < now) {
        console.error('DUOIDAL_TOKEN: token expired')
        process.exit(1)
      }
    }

    return { sub, accessToken: envToken, refreshToken: '' }
  }

  const stored = readToken()
  if (!stored) {
    console.error('Not logged in. Run: duoidal auth login')
    process.exit(1)
  }

  let sub: string
  try {
    sub = getSubClaim(stored.access_token)
  } catch (err) {
    if (err instanceof NonUuidSubError) {
      console.error(err.message)
    } else {
      console.error('Invalid token — no sub claim. Run: duoidal auth login')
    }
    process.exit(1)
  }

  const exp = getExpiresAt(stored.access_token)
  if (exp !== undefined) {
    const now = Math.floor(Date.now() / 1000)
    if (exp < now) {
      // Token expired — attempt refresh if we have a refresh_token
      const storedRefreshToken = stored.refresh_token ?? ''
      if (!storedRefreshToken) {
        console.error('Session expired. Run: duoidal auth login')
        process.exit(1)
      }

      // Attempt token refresh via Supabase
      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      const refreshFn = opts?.refreshSessionFn ?? defaultRefreshSession

      try {
        const refreshed = await refreshFn(supabaseUrl, supabaseAnonKey, storedRefreshToken)

        // Persist the new tokens
        writeToken({
          access_token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken,
          expires_at: refreshed.expiresAt,
        })

        // Re-derive sub from the new token. If Supabase returns a refreshed
        // token whose sub isn't a UUID, that's a server bug worth surfacing —
        // don't silently roll forward.
        let refreshedSub: string
        try {
          refreshedSub = getSubClaim(refreshed.accessToken)
        } catch (err) {
          if (err instanceof NonUuidSubError) {
            console.error(`Refresh returned a token with non-UUID sub: ${err.message}`)
          } else {
            console.error('Invalid token — no sub claim. Run: duoidal auth login')
          }
          process.exit(1)
        }

        return {
          sub: refreshedSub,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
        }
      } catch (err) {
        console.error(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`)
        console.error('Session expired. Run: duoidal auth login')
        process.exit(1)
      }
    }
  }

  return {
    sub,
    accessToken: stored.access_token,
    refreshToken: stored.refresh_token ?? '',
  }
}
