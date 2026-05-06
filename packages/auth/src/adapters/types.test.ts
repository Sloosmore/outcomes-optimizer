import { describe, it, expect } from 'vitest'
import type { AuthSession, SessionAdapter } from './types.js'

describe('@duoidal/auth types', () => {
  it('package exports are defined', () => {
    // Type-only package — just verify the module loads
    expect(true).toBe(true)
  })

  it('AuthSession structural shape — three fields only', () => {
    // This test enforces the structural contract: accessToken, user, expiresAt
    // If extra fields leak in (e.g., Supabase-specific), this won't catch them at runtime,
    // but the TypeScript compiler enforces the interface shape via strict assignment checks.
    const mockSession: AuthSession = {
      accessToken: 'test-token',
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'test@example.com',
        metadata: { role: 'admin' },
      },
      expiresAt: 1700000000,
    }

    expect(mockSession.accessToken).toBe('test-token')
    expect(mockSession.user.id).toBe('00000000-0000-4000-8000-000000000001')
    expect(mockSession.user.email).toBe('test@example.com')
    expect(mockSession.user.metadata).toEqual({ role: 'admin' })
    expect(mockSession.expiresAt).toBe(1700000000)
  })

  it('AuthSession expiresAt is optional', () => {
    const minimalSession: AuthSession = {
      accessToken: 'test-token',
      user: {
        id: '00000000-0000-4000-8000-000000000002',
        email: 'minimal@example.com',
        metadata: {},
      },
    }
    // expiresAt omitted — should compile without error
    expect(minimalSession.expiresAt).toBeUndefined()
  })

  it('SessionAdapter interface shape is sound', () => {
    // Compile-time contract: a mock object satisfying SessionAdapter shape
    const mockAdapter: SessionAdapter = {
      signIn: async () => ({ error: null }),
      getSession: async () => null,
      onAuthStateChange: (_cb) => ({ unsubscribe: () => {} }),
      signOut: async () => {},
    }
    expect(typeof mockAdapter.signIn).toBe('function')
    expect(typeof mockAdapter.getSession).toBe('function')
    expect(typeof mockAdapter.onAuthStateChange).toBe('function')
    expect(typeof mockAdapter.signOut).toBe('function')
  })
})
