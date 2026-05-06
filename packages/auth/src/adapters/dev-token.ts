import type { AuthAdapter, AuthToken } from './types.js'

/**
 * DevTokenAdapter — in-memory adapter for development and E2E testing.
 * Accepts a raw JWT and stores it in memory; no Supabase client required.
 * Use `authenticate(token)` to inject a token, then `getToken()` to retrieve it.
 */
export class DevTokenAdapter implements AuthAdapter {
  readonly type = 'dev-token' as const
  private token: AuthToken | null = null

  /**
   * Store a raw JWT access token in memory.
   * @param token - JWT access token string
   */
  async authenticate(token: string): Promise<void> {
    this.token = { accessToken: token }
  }

  async getToken(): Promise<AuthToken> {
    if (!this.token) {
      throw new Error('DevTokenAdapter: no token — call authenticate(token) first')
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
  }
}
