import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type SupabaseClientFactory = (url: string, key: string, opts?: Record<string, unknown>) => SupabaseClient

function createInMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
}

export function createSupabaseClient(url: string, key: string, factory?: SupabaseClientFactory): SupabaseClient {
  const clientFactory = factory ?? createClient
  return clientFactory(url, key, {
    auth: {
      flowType: 'pkce',
      storage: createInMemoryStorage(),
      detectSessionInUrl: false,
      persistSession: false,
    },
  }) as SupabaseClient
}

/**
 * Create a Supabase client authenticated via Bearer token in global headers.
 *
 * Used by CLI commands that have a user JWT and need to call Supabase RPCs.
 * Supabase JS v2 setSession() requires a valid refresh_token, which the CLI
 * doesn't always have (DUOIDAL_TOKEN env bypass has no refresh_token).
 * Passing the JWT in global.headers bypasses session management entirely.
 *
 * @param url - Supabase project URL
 * @param anonKey - Supabase anon key
 * @param accessToken - User's JWT (from token.json or DUOIDAL_TOKEN env)
 * @param factory - Optional factory for testing (defaults to createClient from supabase-js)
 */
export function createAuthenticatedSupabaseClient(
  url: string,
  anonKey: string,
  accessToken: string,
  factory?: (url: string, key: string, opts?: Record<string, unknown>) => SupabaseClient
): SupabaseClient {
  const clientFactory = factory ?? createClient
  return clientFactory(url, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  }) as SupabaseClient
}

/**
 * Refresh a Supabase session using a refresh_token.
 *
 * @param url - Supabase project URL
 * @param anonKey - Supabase anon key
 * @param refreshToken - The stored refresh_token
 * @param factory - Optional Supabase client factory for DI/testing
 * @returns New accessToken, refreshToken, and expiresAt timestamp
 */
export async function refreshSession(
  url: string,
  anonKey: string,
  refreshToken: string,
  factory?: SupabaseClientFactory
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const client = createSupabaseClient(url, anonKey, factory)
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data.session) {
    throw new Error(error?.message ?? 'refresh failed')
  }
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  }
}
