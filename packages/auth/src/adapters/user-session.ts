import type { SupabaseClient } from '@supabase/supabase-js'
import type { SessionAdapter, AuthSession } from './types.js'
import { mapSupabaseSession } from './session-utils.js'

export class UserSessionAdapter implements SessionAdapter {
  constructor(
    private readonly client: SupabaseClient,
    private readonly email: string,
    private readonly password: string,
  ) {}

  async signIn(): Promise<{ error: Error | null }> {
    const { error } = await this.client.auth.signInWithPassword({
      email: this.email,
      password: this.password,
    })
    return { error: error as Error | null }
  }

  async getSession(): Promise<AuthSession | null> {
    const { data } = await this.client.auth.getSession()
    const session = data?.session
    return session ? mapSupabaseSession(session) : null
  }

  onAuthStateChange(cb: (session: AuthSession | null) => void): { unsubscribe: () => void } {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
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
