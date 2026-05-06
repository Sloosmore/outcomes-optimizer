import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'

// Mock config module to control token reads
vi.mock('../lib/config.js', () => ({
  readToken: vi.fn(),
  CONFIG_DIR: path.join(os.tmpdir(), 'duoidal-test-config'),
  TOKEN_PATH: path.join(os.tmpdir(), 'duoidal-test-config', 'token.json'),
  writeToken: vi.fn(),
  getSandboxKeyDir: vi.fn(),
  getSandboxKeyPath: vi.fn(),
  writeSandboxKey: vi.fn(),
  getActorId: vi.fn(),
}))

import { readToken, writeToken } from '../lib/config.js'

const mockReadToken = vi.mocked(readToken)
const mockWriteToken = vi.mocked(writeToken)

// Test UUIDs for sub claims. getSubClaim now requires UUID format (real
// Supabase JWTs always carry a UUID sub) so test fixtures can no longer use
// readable names like 'user-123'. Pinned UUIDs keep test diffs deterministic.
const TEST_SUB_PRIMARY = '00000000-0000-4000-8000-000000000001'
const TEST_SUB_REFRESH = '00000000-0000-4000-8000-000000000002'
const TEST_SUB_WRITE = '00000000-0000-4000-8000-000000000003'
const TEST_SUB_BAD_REFRESH = '00000000-0000-4000-8000-000000000004'
const TEST_SUB_ENV = '00000000-0000-4000-8000-000000000005'

// Build a valid JWT with given claims
function buildJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.fake-signature`
}

// Type for the refreshSession dependency injection
type RefreshSessionFn = (
  url: string,
  anonKey: string,
  refreshToken: string,
  factory?: unknown
) => Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>

describe('requireAuth', () => {
  let mockExit: ReturnType<typeof vi.spyOn>
  let mockConsoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Clear env var between tests
    delete process.env['DUOIDAL_TOKEN']
    delete process.env['SUPABASE_URL']
    delete process.env['SUPABASE_ANON_KEY']
  })

  afterEach(() => {
    mockExit.mockRestore()
    mockConsoleError.mockRestore()
    vi.restoreAllMocks()
  })

  // Fresh import each test to avoid module caching
  async function loadRequireAuth() {
    const mod = await import('../lib/require-auth.js')
    return mod.requireAuth
  }

  it('exits with message when no token is stored', async () => {
    mockReadToken.mockReturnValue(null)
    const fn = await loadRequireAuth()

    await expect(fn()).rejects.toThrow('process.exit')
    expect(mockConsoleError).toHaveBeenCalledWith('Not logged in. Run: duoidal auth login')
    expect(mockExit).toHaveBeenCalledWith(1)
  })

  it('exits with message when token has no sub claim', async () => {
    const token = buildJwt({ aud: 'authenticated' }) // no sub
    mockReadToken.mockReturnValue({ access_token: token, refresh_token: '' })
    const fn = await loadRequireAuth()

    await expect(fn()).rejects.toThrow('process.exit')
    // getSubClaim now flags missing-or-non-UUID sub via NonUuidSubError; the
    // require-auth wrapper surfaces the error's own message (which points at
    // `duoidal auth login`).
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('not a UUID'))
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('duoidal auth login'))
  })

  it('exits with message when token is expired and no refresh_token', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
    const token = buildJwt({ sub: TEST_SUB_PRIMARY, exp: pastExp })
    mockReadToken.mockReturnValue({ access_token: token, refresh_token: '' })
    const fn = await loadRequireAuth()

    await expect(fn()).rejects.toThrow('process.exit')
    expect(mockConsoleError).toHaveBeenCalledWith('Session expired. Run: duoidal auth login')
  })

  it('returns sub and accessToken for a valid non-expired token', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
    const token = buildJwt({ sub: TEST_SUB_PRIMARY, exp: futureExp, aud: 'authenticated' })
    mockReadToken.mockReturnValue({ access_token: token, refresh_token: 'refresh-xyz' })
    const fn = await loadRequireAuth()

    const result = await fn()
    expect(result.sub).toBe(TEST_SUB_PRIMARY)
    expect(result.accessToken).toBe(token)
    expect(mockExit).not.toHaveBeenCalled()
  })

  it('returns sub for a valid token with no exp (no expiry check)', async () => {
    const token = buildJwt({ sub: TEST_SUB_PRIMARY }) // no exp claim
    mockReadToken.mockReturnValue({ access_token: token, refresh_token: '' })
    const fn = await loadRequireAuth()

    const result = await fn()
    expect(result.sub).toBe(TEST_SUB_PRIMARY)
    expect(mockExit).not.toHaveBeenCalled()
  })

  it('exits when token is malformed (not 3 parts)', async () => {
    mockReadToken.mockReturnValue({ access_token: 'not-a-jwt', refresh_token: '' })
    const fn = await loadRequireAuth()

    await expect(fn()).rejects.toThrow('process.exit')
    expect(mockConsoleError).toHaveBeenCalledWith('Invalid token — no sub claim. Run: duoidal auth login')
  })

  it('exits when token payload is not valid JSON', async () => {
    mockReadToken.mockReturnValue({ access_token: 'header.not-valid-base64!.sig', refresh_token: '' })
    const fn = await loadRequireAuth()

    await expect(fn()).rejects.toThrow('process.exit')
    expect(mockConsoleError).toHaveBeenCalledWith('Invalid token — no sub claim. Run: duoidal auth login')
  })

  // ── Async refresh tests ──────────────────────────────────────────────────

  describe('token refresh via Supabase', () => {
    it('refreshes session when access_token expired + valid refresh_token', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600
      const futureExp = Math.floor(Date.now() / 1000) + 3600
      const oldToken = buildJwt({ sub: TEST_SUB_REFRESH, exp: pastExp })
      const newToken = buildJwt({ sub: TEST_SUB_REFRESH, exp: futureExp })

      mockReadToken.mockReturnValue({
        access_token: oldToken,
        refresh_token: 'valid-refresh-token',
      })

      const mockRefreshSession: RefreshSessionFn = vi.fn().mockResolvedValue({
        accessToken: newToken,
        refreshToken: 'new-refresh-token',
        expiresAt: futureExp,
      })

      // Import with DI factory
      const { requireAuth } = await import('../lib/require-auth.js') as {
        requireAuth: (opts?: { refreshSessionFn?: RefreshSessionFn }) => Promise<{ sub: string; accessToken: string; refreshToken: string }>
      }

      const result = await requireAuth({ refreshSessionFn: mockRefreshSession })

      expect(result.sub).toBe(TEST_SUB_REFRESH)
      expect(result.accessToken).toBe(newToken)
      expect(result.refreshToken).toBe('new-refresh-token')
      expect(mockExit).not.toHaveBeenCalled()
    })

    it('writes token.json with new access_token after refresh', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600
      const futureExp = Math.floor(Date.now() / 1000) + 3600
      const oldToken = buildJwt({ sub: TEST_SUB_WRITE, exp: pastExp })
      const newToken = buildJwt({ sub: TEST_SUB_WRITE, exp: futureExp })

      mockReadToken.mockReturnValue({
        access_token: oldToken,
        refresh_token: 'valid-refresh-token',
      })

      const mockRefreshSession: RefreshSessionFn = vi.fn().mockResolvedValue({
        accessToken: newToken,
        refreshToken: 'new-refresh-token',
        expiresAt: futureExp,
      })

      const { requireAuth } = await import('../lib/require-auth.js') as {
        requireAuth: (opts?: { refreshSessionFn?: RefreshSessionFn }) => Promise<{ sub: string; accessToken: string; refreshToken: string }>
      }

      await requireAuth({ refreshSessionFn: mockRefreshSession })

      expect(mockWriteToken).toHaveBeenCalledWith({
        access_token: newToken,
        refresh_token: 'new-refresh-token',
        expires_at: futureExp,
      })
    })

    it('exits when refresh_token is invalid (refresh fails)', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600
      const oldToken = buildJwt({ sub: TEST_SUB_BAD_REFRESH, exp: pastExp })

      mockReadToken.mockReturnValue({
        access_token: oldToken,
        refresh_token: 'invalid-refresh-token',
      })

      const mockRefreshSession: RefreshSessionFn = vi.fn().mockRejectedValue(
        new Error('Invalid Refresh Token')
      )

      const { requireAuth } = await import('../lib/require-auth.js') as {
        requireAuth: (opts?: { refreshSessionFn?: RefreshSessionFn }) => Promise<{ sub: string; accessToken: string; refreshToken: string }>
      }

      await expect(requireAuth({ refreshSessionFn: mockRefreshSession })).rejects.toThrow('process.exit')
      expect(mockConsoleError).toHaveBeenCalledWith('Session expired. Run: duoidal auth login')
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  // ── DUOIDAL_TOKEN env bypass tests ──────────────────────────────────────

  describe('DUOIDAL_TOKEN env bypass', () => {
    it('returns sub from env token when valid', async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600
      const envToken = buildJwt({ sub: TEST_SUB_ENV, exp: futureExp })
      process.env['DUOIDAL_TOKEN'] = envToken

      const fn = await loadRequireAuth()
      const result = await fn()

      expect(result.sub).toBe(TEST_SUB_ENV)
      expect(result.accessToken).toBe(envToken)
      expect(result.refreshToken).toBe('')
      expect(mockExit).not.toHaveBeenCalled()
    })

    it('exits when DUOIDAL_TOKEN is expired (no refresh attempted)', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600
      const envToken = buildJwt({ sub: TEST_SUB_ENV, exp: pastExp })
      process.env['DUOIDAL_TOKEN'] = envToken

      const mockRefreshSession: RefreshSessionFn = vi.fn()

      const { requireAuth } = await import('../lib/require-auth.js') as {
        requireAuth: (opts?: { refreshSessionFn?: RefreshSessionFn }) => Promise<{ sub: string; accessToken: string; refreshToken: string }>
      }

      await expect(requireAuth({ refreshSessionFn: mockRefreshSession })).rejects.toThrow('process.exit')
      expect(mockConsoleError).toHaveBeenCalledWith('DUOIDAL_TOKEN: token expired')
      // Env token path must NOT attempt refresh
      expect(mockRefreshSession).not.toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('exits when DUOIDAL_TOKEN has no sub claim', async () => {
      const envToken = buildJwt({ aud: 'authenticated' })
      process.env['DUOIDAL_TOKEN'] = envToken

      const fn = await loadRequireAuth()
      await expect(fn()).rejects.toThrow('process.exit')
      // Same path as the stored-token case: NonUuidSubError surfaces with the
      // 'DUOIDAL_TOKEN: ' prefix added by require-auth.
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringMatching(/^DUOIDAL_TOKEN: /))
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('not a UUID'))
    })
  })
})
