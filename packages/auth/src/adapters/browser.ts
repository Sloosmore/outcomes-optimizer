import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrowserAuthAdapter as IBrowserAuthAdapter, AuthToken } from './types.js'
import { AuthError } from './access-code.js'

export class BrowserAuthAdapter implements IBrowserAuthAdapter {
  readonly type = 'browser' as const

  constructor(private readonly client: SupabaseClient) {}

  async getToken(): Promise<AuthToken> {
    const { data, error } = await this.client.auth.getSession()
    if (error || !data.session) {
      throw new AuthError('No active browser session', 'NOT_AUTHENTICATED')
    }
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token ?? undefined,
      expiresAt: data.session.expires_at ?? undefined,
    }
  }

  async isAuthenticated(): Promise<boolean> {
    const { data } = await this.client.auth.getSession()
    return !!data.session
  }

  async logout(): Promise<void> {
    await this.client.auth.signOut()
  }
}
