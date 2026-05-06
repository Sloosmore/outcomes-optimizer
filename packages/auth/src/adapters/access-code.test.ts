import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AccessCodeAuthAdapter, AuthError } from './access-code.js'
import type { SupabaseClient } from '@supabase/supabase-js'

// Minimal mock — only the auth methods we call
function makeMockClient(overrides?: Partial<{ verifyOtp: ReturnType<typeof vi.fn>, signOut: ReturnType<typeof vi.fn> }>) {
  return {
    auth: {
      verifyOtp: overrides?.verifyOtp ?? vi.fn(),
      signOut: overrides?.signOut ?? vi.fn().mockResolvedValue({}),
    },
  } as unknown as SupabaseClient
}

const MOCK_SESSION = {
  access_token: 'header.eyJzdWIiOiJ1c2VyLTEyMyIsImV4cCI6OTk5OTk5OTk5OX0.sig',
  refresh_token: 'refresh-xyz',
  expires_at: 9999999999,
}

describe('AccessCodeAuthAdapter', () => {
  describe('exchangeCode', () => {
    it('returns AuthToken on valid code', async () => {
      const verifyOtp = vi.fn().mockResolvedValue({ data: { session: MOCK_SESSION }, error: null })
      const adapter = new AccessCodeAuthAdapter(makeMockClient({ verifyOtp }))

      const token = await adapter.exchangeCode('user@example.com', 'VALID-CODE')

      expect(verifyOtp).toHaveBeenCalledWith({
        email: 'user@example.com',
        token: 'VALID-CODE',
        type: 'email',
      })
      expect(token.accessToken).toBe(MOCK_SESSION.access_token)
      expect(token.refreshToken).toBe(MOCK_SESSION.refresh_token)
      expect(token.expiresAt).toBe(MOCK_SESSION.expires_at)
    })

    it('throws AuthError with INVALID_CODE when Supabase returns error', async () => {
      const verifyOtp = vi.fn().mockResolvedValue({
        data: { session: null },
        error: { message: 'Token has expired or is invalid' },
      })
      const adapter = new AccessCodeAuthAdapter(makeMockClient({ verifyOtp }))

      await expect(adapter.exchangeCode('user@example.com', 'EXPIRED')).rejects.toMatchObject({
        code: 'INVALID_CODE',
      })
    })

    it('throws AuthError when session is null even without error message', async () => {
      const verifyOtp = vi.fn().mockResolvedValue({ data: { session: null }, error: null })
      const adapter = new AccessCodeAuthAdapter(makeMockClient({ verifyOtp }))

      await expect(adapter.exchangeCode('user@example.com', 'BAD')).rejects.toBeInstanceOf(AuthError)
    })

    it('stores token for subsequent getToken() calls', async () => {
      const verifyOtp = vi.fn().mockResolvedValue({ data: { session: MOCK_SESSION }, error: null })
      const adapter = new AccessCodeAuthAdapter(makeMockClient({ verifyOtp }))

      await adapter.exchangeCode('user@example.com', 'CODE')
      const token = await adapter.getToken()
      expect(token.accessToken).toBe(MOCK_SESSION.access_token)
    })
  })

  describe('getToken', () => {
    it('throws NOT_AUTHENTICATED when no exchange has occurred', async () => {
      const adapter = new AccessCodeAuthAdapter(makeMockClient())
      await expect(adapter.getToken()).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' })
    })
  })

  describe('isAuthenticated', () => {
    it('returns false when no token', async () => {
      const adapter = new AccessCodeAuthAdapter(makeMockClient())
      expect(await adapter.isAuthenticated()).toBe(false)
    })

    it('returns true when token is valid and not expired', async () => {
      const verifyOtp = vi.fn().mockResolvedValue({ data: { session: MOCK_SESSION }, error: null })
      const adapter = new AccessCodeAuthAdapter(makeMockClient({ verifyOtp }))
      await adapter.exchangeCode('user@example.com', 'CODE')
      expect(await adapter.isAuthenticated()).toBe(true)
    })

    it('returns false when token is expired', async () => {
      const expiredSession = { ...MOCK_SESSION, expires_at: 1 } // epoch 1 = 1970
      const verifyOtp = vi.fn().mockResolvedValue({ data: { session: expiredSession }, error: null })
      const adapter = new AccessCodeAuthAdapter(makeMockClient({ verifyOtp }))
      await adapter.exchangeCode('user@example.com', 'CODE')
      expect(await adapter.isAuthenticated()).toBe(false)
    })
  })

  describe('logout', () => {
    it('clears token and calls signOut', async () => {
      const verifyOtp = vi.fn().mockResolvedValue({ data: { session: MOCK_SESSION }, error: null })
      const signOut = vi.fn().mockResolvedValue({})
      const adapter = new AccessCodeAuthAdapter(makeMockClient({ verifyOtp, signOut }))

      await adapter.exchangeCode('user@example.com', 'CODE')
      expect(await adapter.isAuthenticated()).toBe(true)

      await adapter.logout()
      expect(signOut).toHaveBeenCalledOnce()
      expect(await adapter.isAuthenticated()).toBe(false)
    })
  })
})
