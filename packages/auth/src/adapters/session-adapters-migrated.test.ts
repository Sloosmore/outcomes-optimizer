import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Must be declared before the mock factory so the closure captures the binding
let magicLinkMockClient: ReturnType<typeof makeClient>

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: vi.fn(() => magicLinkMockClient),
}))

import { AnonymousSessionAdapter } from './anonymous-session.js'
import { MagicLinkSessionAdapter } from './magic-link-session.js'
import type { SupabaseClient } from '@supabase/supabase-js'

const MOCK_SUPABASE_SESSION = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_at: 1234567890,
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'test@example.com',
    user_metadata: { role: 'user' },
  },
}

function makeClient(overrides: Partial<SupabaseClient['auth']> = {}) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      signInAnonymously: vi.fn().mockResolvedValue({ error: null }),
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      ...overrides,
    },
  } as unknown as SupabaseClient
}

describe('AnonymousSessionAdapter', () => {
  let client: SupabaseClient
  let adapter: AnonymousSessionAdapter

  beforeEach(() => {
    client = makeClient()
    adapter = new AnonymousSessionAdapter(client)
  })

  describe('getSession', () => {
    it('returns null when no session exists', async () => {
      const session = await adapter.getSession()
      expect(session).toBeNull()
    })

    it('returns AuthSession when session exists', async () => {
      client.auth.getSession = vi.fn().mockResolvedValue({ data: { session: MOCK_SUPABASE_SESSION } })
      const session = await adapter.getSession()
      expect(session).not.toBeNull()
      expect(session?.accessToken).toBe('test-access-token')
      expect(session?.user.id).toBe('00000000-0000-4000-8000-000000000001')
      expect(session?.user.email).toBe('test@example.com')
      expect(session?.user.metadata).toEqual({ role: 'user' })
      expect(session?.expiresAt).toBe(1234567890)
    })
  })

  describe('signIn', () => {
    it('calls signInAnonymously and returns { error: null } on success', async () => {
      const result = await adapter.signIn()
      expect(client.auth.signInAnonymously).toHaveBeenCalledOnce()
      expect(result.error).toBeNull()
    })

    it('calls signInAnonymously even when a session already exists', async () => {
      client.auth.getSession = vi.fn().mockResolvedValue({ data: { session: MOCK_SUPABASE_SESSION } })
      const result = await adapter.signIn()
      expect(client.auth.signInAnonymously).toHaveBeenCalledOnce()
      expect(result.error).toBeNull()
    })

    it('returns error when signInAnonymously fails', async () => {
      const err = new Error('Auth failed')
      client.auth.signInAnonymously = vi.fn().mockResolvedValue({ error: err })
      const result = await adapter.signIn()
      expect(result.error).toBe(err)
    })
  })

  describe('onAuthStateChange', () => {
    it('registers a listener and returns unsubscribe', () => {
      const cb = vi.fn()
      const { unsubscribe } = adapter.onAuthStateChange(cb)
      expect(client.auth.onAuthStateChange).toHaveBeenCalledOnce()
      expect(typeof unsubscribe).toBe('function')
    })

    it('calls callback with AuthSession shape when auth state changes', () => {
      const cb = vi.fn()
      let capturedHandler: ((event: string, session: typeof MOCK_SUPABASE_SESSION | null) => void) | undefined
      client.auth.onAuthStateChange = vi.fn().mockImplementation((handler) => {
        capturedHandler = handler
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      })
      adapter.onAuthStateChange(cb)
      capturedHandler?.('SIGNED_IN', MOCK_SUPABASE_SESSION)
      expect(cb).toHaveBeenCalledOnce()
      const receivedSession = cb.mock.calls[0][0]
      expect(receivedSession?.accessToken).toBe('test-access-token')
      expect(receivedSession?.user.id).toBe('00000000-0000-4000-8000-000000000001')
      expect(receivedSession?.user.email).toBe('test@example.com')
      expect(receivedSession?.user.metadata).toEqual({ role: 'user' })
    })

    it('unsubscribes correctly', () => {
      const unsubscribeFn = vi.fn()
      client.auth.onAuthStateChange = vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: unsubscribeFn } },
      })
      const { unsubscribe } = adapter.onAuthStateChange(vi.fn())
      unsubscribe()
      expect(unsubscribeFn).toHaveBeenCalledOnce()
    })
  })
})

describe('MagicLinkSessionAdapter.signIn', () => {
  let adapter: MagicLinkSessionAdapter

  beforeEach(() => {
    magicLinkMockClient = makeClient()
    adapter = new MagicLinkSessionAdapter(magicLinkMockClient)
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns { error: null } when fetch succeeds with ok response', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)
    const result = await adapter.signIn('user@example.com', '123456')
    expect(result).toEqual({ error: null })
    expect(fetch).toHaveBeenCalledWith('/auth/magic-link', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', code: '123456' }),
    }))
  })

  it('returns { error: Error } when fetch returns non-ok status', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ message: 'Invalid code' }),
    } as unknown as Response)
    const result = await adapter.signIn('user@example.com', 'bad-code')
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.message).toBe('Invalid code')
  })

  it('returns { error: Error } when fetch throws a network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network failure'))
    const result = await adapter.signIn('user@example.com', '123456')
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.message).toBe('network failure')
  })

  it('returns { error: Error("email and code required") } when email or code missing', async () => {
    const resultNoCode = await adapter.signIn('user@example.com')
    expect(resultNoCode.error).toBeInstanceOf(Error)
    expect(resultNoCode.error?.message).toBe('email and code required')

    const resultNoEmail = await adapter.signIn(undefined, '123456')
    expect(resultNoEmail.error).toBeInstanceOf(Error)
    expect(resultNoEmail.error?.message).toBe('email and code required')
  })

  it('includes returnTo in body when a valid path override is passed', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)
    await adapter.signIn('user@example.com', '123456', { returnTo: '/cli-auth?redirect=http%3A%2F%2Flocalhost%3A4000%2Fcallback' })
    expect(fetch).toHaveBeenCalledWith('/auth/magic-link', expect.objectContaining({
      body: JSON.stringify({ email: 'user@example.com', code: '123456', returnTo: '/cli-auth?redirect=http%3A%2F%2Flocalhost%3A4000%2Fcallback' }),
    }))
  })

  it('strips protocol-relative returnTo override (open redirect prevention)', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)
    await adapter.signIn('user@example.com', '123456', { returnTo: '//evil.com' })
    expect(fetch).toHaveBeenCalledWith('/auth/magic-link', expect.objectContaining({
      body: JSON.stringify({ email: 'user@example.com', code: '123456' }),
    }))
  })

  it('strips absolute URL returnTo override (open redirect prevention)', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)
    await adapter.signIn('user@example.com', '123456', { returnTo: 'https://evil.com/steal' })
    expect(fetch).toHaveBeenCalledWith('/auth/magic-link', expect.objectContaining({
      body: JSON.stringify({ email: 'user@example.com', code: '123456' }),
    }))
  })
})
