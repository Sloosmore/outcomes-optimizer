import { createBrowserClient } from '@supabase/ssr'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import type { SessionAdapter, AuthSession } from './types.js'
import { mapSupabaseSession } from './session-utils.js'

export class DebugSessionAdapter implements SessionAdapter {
  private readonly client: ReturnType<typeof createBrowserClient>

  constructor(
    supabaseUrl: string,
    supabaseAnonKey: string,
    private readonly email: string,
    private readonly password: string,
    private readonly resetFn: () => Promise<void>,
  ) {
    this.client = createBrowserClient(supabaseUrl, supabaseAnonKey)
  }

  async signIn(email?: string, code?: string, _options?: { returnTo?: string }): Promise<{ error: Error | null }> {
    const { error } = await this.client.auth.signInWithPassword({
      email: email ?? this.email,
      password: code ?? this.password,
    })
    return { error: error as Error | null }
  }

  async getSession(): Promise<AuthSession | null> {
    const { data: existing } = await this.client.auth.getSession()
    if (existing?.session) {
      return mapSupabaseSession(existing.session)
    }

    let { error } = await this.client.auth.signInWithPassword({
      email: this.email,
      password: this.password,
    })

    if (error) {
      await this.resetFn()
      const retry = await this.client.auth.signInWithPassword({
        email: this.email,
        password: this.password,
      })
      if (retry.error) {
        return null
      }
    }

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
