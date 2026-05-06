import type { SupabaseClient, AuthChangeEvent, Session } from '@supabase/supabase-js'
import type { SessionAdapter, AuthSession } from './types.js'
import { mapSupabaseSession } from './session-utils.js'

type SignInReturningResult =
  | { status: 'ok' }
  | { status: 'not-found' }
  | { status: 'error'; error: Error }

export class MagicLinkSessionAdapter implements SessionAdapter {
  private readonly client: SupabaseClient

  constructor(client: SupabaseClient) {
    this.client = client
  }

  private getReturnTo(override?: string): string {
    const raw = override
      ?? (typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('returnTo') ?? ''
        : '')
    if (!raw.startsWith('/') || raw.startsWith('//')) return ''
    // Strip fragment. A failed magic-link redeem leaves an `#error=...&error_code=otp_expired`
    // fragment on the URL; if we forward returnTo verbatim, that fragment ends up
    // inside the next magic link's redirect_to. Supabase's /auth/v1/verify preserves
    // the fragment after a successful verify, so the user lands on a URL that looks
    // exactly like an expired-link error — even though the new link verified fine.
    const hashIdx = raw.indexOf('#')
    return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
  }

  /**
   * Check if a user exists and, if so, send them a magic link. Returns 'not-found' if the email
   * has no account. Delegates to the server so no OTP is triggered for non-existent users
   * (avoids Supabase's 60-second rate limit when both this check and the code-submission flow
   * send OTPs within the same minute).
   */
  async signInReturning(email: string, options?: { returnTo?: string }): Promise<SignInReturningResult> {
    const returnTo = this.getReturnTo(options?.returnTo)
    try {
      const response = await fetch('/auth/check-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, ...(returnTo ? { returnTo } : {}) }),
      })

      if (!response.ok) {
        let message = `Check-email request failed with status ${response.status}`
        try {
          const body = await response.json() as { error?: string }
          message = body.error ?? message
        } catch {
          // ignore parse errors
        }
        return { status: 'error', error: new Error(message) }
      }

      const data = await response.json() as { exists?: boolean; error?: string }
      if (data.error) return { status: 'error', error: new Error(data.error) }
      return { status: data.exists ? 'ok' : 'not-found' }
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  async signIn(email?: string, code?: string, options?: { returnTo?: string }): Promise<{ error: Error | null }> {
    if (!email || !code) {
      return { error: new Error('email and code required') }
    }

    const returnTo = this.getReturnTo(options?.returnTo)
    try {
      const response = await fetch('/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, ...(returnTo ? { returnTo } : {}) }),
      })

      if (!response.ok) {
        let message = `Magic link request failed with status ${response.status}`
        try {
          const body = await response.json() as { message?: string; error?: string }
          message = body.message ?? body.error ?? message
        } catch {
          // ignore parse errors, use default message
        }
        return { error: new Error(message) }
      }

      return { error: null }
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) }
    }
  }

  async getSession(): Promise<AuthSession | null> {
    const { data } = await this.client.auth.getSession()
    const session = data?.session
    return session ? mapSupabaseSession(session) : null
  }

  onAuthStateChange(cb: (session: AuthSession | null) => void): { unsubscribe: () => void } {
    const { data } = this.client.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      cb(session ? mapSupabaseSession(session) : null)
    })
    return {
      unsubscribe: () => data.subscription.unsubscribe(),
    }
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut()
  }
}
