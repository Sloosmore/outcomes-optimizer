import { describe, it, expect, vi, beforeEach } from 'vitest'

// Must be declared before the mock factory so the closure captures the binding
let mockClient: ReturnType<typeof makeClient>

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: vi.fn(() => mockClient),
}))

import { DebugSessionAdapter } from './debug-session.js'

const MOCK_SESSION = {
  access_token: 'tok-debug',
  refresh_token: 'ref-debug',
  expires_at: 9999999999,
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'debug@example.com',
    user_metadata: { role: 'admin' },
  },
}

function makeClient(
  signInResult: { error: Error | null } = { error: null },
  session: object | null = MOCK_SESSION,
) {
  return {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ error: signInResult.error }),
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      signOut: vi.fn().mockResolvedValue({}),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
  } as any
}

/** Client that starts with no session, then returns MOCK_SESSION after sign-in */
function makeClientNoSession() {
  const client = makeClient({ error: null }, null)
  // First getSession call (existing session check) → null
  // Second getSession call (after sign-in) → MOCK_SESSION
  client.auth.getSession
    .mockResolvedValueOnce({ data: { session: null }, error: null })
    .mockResolvedValueOnce({ data: { session: MOCK_SESSION }, error: null })
  return client
}

describe('DebugSessionAdapter', () => {
  it('lazy construction: signInWithPassword is NOT called in constructor', () => {
    mockClient = makeClient()
    const resetFn = vi.fn().mockResolvedValue(undefined)
    new DebugSessionAdapter('https://fake.supabase.co', 'fake-anon-key', 'debug@example.com', 'secret', resetFn)
    expect(mockClient.auth.signInWithPassword).toHaveBeenCalledTimes(0)
  })

  it('resetFn called on auth failure then retry', async () => {
    mockClient = makeClientNoSession()
    mockClient.auth.signInWithPassword
      .mockResolvedValueOnce({ error: new Error('Invalid credentials') })
      .mockResolvedValueOnce({ error: null })

    const resetFn = vi.fn().mockResolvedValue(undefined)
    const adapter = new DebugSessionAdapter('https://fake.supabase.co', 'fake-anon-key', 'debug@example.com', 'secret', resetFn)
    await adapter.getSession()
    expect(resetFn).toHaveBeenCalledTimes(1)
  })

  it('retry succeeds after resetFn: returns valid AuthSession', async () => {
    mockClient = makeClientNoSession()
    mockClient.auth.signInWithPassword
      .mockResolvedValueOnce({ error: new Error('Invalid credentials') })
      .mockResolvedValueOnce({ error: null })

    const resetFn = vi.fn().mockResolvedValue(undefined)
    const adapter = new DebugSessionAdapter('https://fake.supabase.co', 'fake-anon-key', 'debug@example.com', 'secret', resetFn)
    const result = await adapter.getSession()
    expect(result).not.toBeNull()
    expect(result?.accessToken).toBe('tok-debug')
    expect(result?.user.id).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('returns AuthSession shape (not Supabase Session shape)', async () => {
    mockClient = makeClient()
    const resetFn = vi.fn().mockResolvedValue(undefined)
    const adapter = new DebugSessionAdapter('https://fake.supabase.co', 'fake-anon-key', 'debug@example.com', 'secret', resetFn)
    const result = await adapter.getSession()

    expect(result).not.toBeNull()
    // AuthSession shape
    expect(typeof result!.accessToken).toBe('string')
    expect(typeof result!.user.id).toBe('string')
    expect(typeof result!.user.email).toBe('string')
    expect(typeof result!.user.metadata).toBe('object')
    expect(result!.expiresAt).toBe(9999999999)
    // No snake_case Supabase fields
    expect((result as any).access_token).toBeUndefined()
  })
})
