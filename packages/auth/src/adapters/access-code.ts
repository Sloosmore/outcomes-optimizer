import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessCodeAuthAdapter as IAccessCodeAuthAdapter, AuthToken } from './types.js'

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_CODE' | 'NOT_AUTHENTICATED' | 'SESSION_EXPIRED'
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export class AccessCodeAuthAdapter implements IAccessCodeAuthAdapter {
  readonly type = 'access-code' as const
  private token: AuthToken | null = null

  constructor(private readonly client: SupabaseClient) {}

  async exchangeCode(email: string, code: string): Promise<AuthToken> {
    const { data, error } = await this.client.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    })

    if (error || !data.session) {
      throw new AuthError(
        error?.message ?? 'Invalid or expired access code',
        'INVALID_CODE'
      )
    }

    const token: AuthToken = {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token ?? undefined,
      expiresAt: data.session.expires_at ?? undefined,
    }
    this.token = token
    return token
  }

  async getToken(): Promise<AuthToken> {
    if (!this.token) {
      throw new AuthError('Not authenticated — call exchangeCode() first', 'NOT_AUTHENTICATED')
    }
    return this.token
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.token) return false
    if (
      this.token.expiresAt !== undefined &&
      Math.floor(Date.now() / 1000) >= this.token.expiresAt
    ) {
      return false
    }
    return true
  }

  async logout(): Promise<void> {
    this.token = null
    await this.client.auth.signOut()
  }
}
