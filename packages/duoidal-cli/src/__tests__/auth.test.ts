import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Top-level mock — hoisted before imports, so no variable references allowed in factory
vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>()
  return {
    ...actual,
    writeToken: vi.fn(),
    readToken: vi.fn(),
  }
})

import { authCommand } from '../commands/auth.js'
import type { IAccessCodeAdapter, ICLIAdapter, AccessCodeAdapterFactory, CLIAdapterFactory } from '../commands/auth.js'
import * as config from '../lib/config.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-auth-test-'))
  vi.mocked(config.writeToken).mockReset()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

// Run the auth login subcommand with given args and optional adapter factories
async function runLogin(
  args: string[],
  cliFactory?: CLIAdapterFactory,
  accessCodeFactory?: AccessCodeAdapterFactory
) {
  const cmd = authCommand(cliFactory, accessCodeFactory)
  cmd.exitOverride()
  const loginCmd = cmd.commands.find((c) => c.name() === 'login')
  if (loginCmd) loginCmd.exitOverride()
  return cmd.parseAsync(['node', 'duoidal', 'login', ...args])
}

// ---------------------------------------------------------------------------
// 1. --token flag (backward compat)
// ---------------------------------------------------------------------------

describe('auth login --token', () => {
  it('stores the token directly without calling any adapter', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin(['--token', 'my.jwt.token'])

    expect(config.writeToken).toHaveBeenCalledWith({
      access_token: 'my.jwt.token',
      refresh_token: '',
    })
    expect(consoleSpy).toHaveBeenCalledWith('Token stored at ~/.config/duoidal/token.json')
  })

  it('does not call any adapter factory when --token is provided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const mockCLIFactory: CLIAdapterFactory = vi.fn()
    const mockACFactory: AccessCodeAdapterFactory = vi.fn()

    await runLogin(['--token', 'test.jwt'], mockCLIFactory, mockACFactory)

    expect(mockCLIFactory).not.toHaveBeenCalled()
    expect(mockACFactory).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2. --access-code + --email flag
// ---------------------------------------------------------------------------

describe('auth login --access-code', () => {
  it('calls AccessCodeAdapter.exchangeCode and stores token', async () => {
    const tokenResponse = {
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
      expiresAt: 9999999,
    }

    const mockExchangeCode = vi.fn().mockResolvedValue(tokenResponse)
    const mockAdapter: IAccessCodeAdapter = { exchangeCode: mockExchangeCode }
    const mockFactory: AccessCodeAdapterFactory = vi.fn().mockReturnValue(mockAdapter)

    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin(['--access-code', '123456', '--email', 'user@example.com'], undefined, mockFactory)

    expect(mockFactory).toHaveBeenCalledWith('https://test.supabase.co', 'anon-key')
    expect(mockExchangeCode).toHaveBeenCalledWith('user@example.com', '123456')
    expect(config.writeToken).toHaveBeenCalledWith({
      access_token: 'access-jwt',
      refresh_token: 'refresh-jwt',
      expires_at: 9999999,
    })
    expect(consoleSpy).toHaveBeenCalledWith('Token stored at ~/.config/duoidal/token.json')
  })

  it('maps undefined refreshToken to empty string', async () => {
    const tokenResponse = {
      accessToken: 'access-jwt',
      // no refreshToken
    }

    const mockExchangeCode = vi.fn().mockResolvedValue(tokenResponse)
    const mockAdapter: IAccessCodeAdapter = { exchangeCode: mockExchangeCode }
    const mockFactory: AccessCodeAdapterFactory = vi.fn().mockReturnValue(mockAdapter)

    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin(['--access-code', '654321', '--email', 'other@example.com'], undefined, mockFactory)

    expect(config.writeToken).toHaveBeenCalledWith({
      access_token: 'access-jwt',
      refresh_token: '',
      expires_at: undefined,
    })
  })

  it('prints error and exits when --email is missing with --access-code', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(
      runLogin(['--access-code', '123456'])
    ).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith('Error: --email is required when using --access-code')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('uses production Supabase constants when SUPABASE env vars are missing for --access-code', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

    const tokenResponse = {
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
      expiresAt: 9999999,
    }

    const mockExchangeCode = vi.fn().mockResolvedValue(tokenResponse)
    const mockAdapter: IAccessCodeAdapter = { exchangeCode: mockExchangeCode }
    const mockFactory: AccessCodeAdapterFactory = vi.fn().mockReturnValue(mockAdapter)

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin(['--access-code', '123456', '--email', 'user@example.com'], undefined, mockFactory)

    // Must be called with production fallback constants, not empty strings
    expect(mockFactory).toHaveBeenCalledWith(
      expect.stringContaining('supabase.co'),
      expect.stringMatching(/^(eyJ|sb_publishable_)/)
    )
    expect(mockExchangeCode).toHaveBeenCalledWith('user@example.com', '123456')
  })
})

// ---------------------------------------------------------------------------
// 3. Browser OAuth flow via CLIAdapter
// ---------------------------------------------------------------------------

describe('auth login (browser OAuth)', () => {
  it('calls CLIAdapter.startAppFlow with default URL and stores token', async () => {
    const tokenResponse = {
      accessToken: 'oauth-access-jwt',
      refreshToken: 'oauth-refresh-jwt',
      expiresAt: 8888888,
    }

    const mockStartOAuthFlow = vi.fn()
    const mockStartAppFlow = vi.fn().mockResolvedValue(tokenResponse)
    const mockLoginWithAccessCode = vi.fn()
    const mockCLIAdapter: ICLIAdapter = {
      startOAuthFlow: mockStartOAuthFlow,
      startAppFlow: mockStartAppFlow,
      loginWithAccessCode: mockLoginWithAccessCode,
    }
    const mockCLIFactory: CLIAdapterFactory = vi.fn().mockReturnValue(mockCLIAdapter)

    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    vi.stubEnv('DUOIDAL_APP_URL', '')

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin([], mockCLIFactory)

    expect(mockCLIFactory).toHaveBeenCalledWith('https://test.supabase.co', 'anon-key')
    expect(mockStartAppFlow).toHaveBeenCalledWith('https://example.com')
    expect(config.writeToken).toHaveBeenCalledWith({
      access_token: 'oauth-access-jwt',
      refresh_token: 'oauth-refresh-jwt',
      expires_at: 8888888,
    })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Authenticated'))
  })

  it('uses production Supabase constants when SUPABASE env vars are missing for browser OAuth', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    vi.stubEnv('DUOIDAL_APP_URL', '')

    const tokenResponse = {
      accessToken: 'oauth-access-jwt',
      refreshToken: 'oauth-refresh-jwt',
      expiresAt: 8888888,
    }

    const mockStartOAuthFlow = vi.fn()
    const mockStartAppFlow = vi.fn().mockResolvedValue(tokenResponse)
    const mockLoginWithAccessCode = vi.fn()
    const mockCLIAdapter: ICLIAdapter = {
      startOAuthFlow: mockStartOAuthFlow,
      startAppFlow: mockStartAppFlow,
      loginWithAccessCode: mockLoginWithAccessCode,
    }
    const mockCLIFactory: CLIAdapterFactory = vi.fn().mockReturnValue(mockCLIAdapter)

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin([], mockCLIFactory)

    // Must be called with production fallback constants, not empty strings
    expect(mockCLIFactory).toHaveBeenCalledWith(
      expect.stringContaining('supabase.co'),
      expect.stringMatching(/^(eyJ|sb_publishable_)/)
    )
    expect(mockStartAppFlow).toHaveBeenCalledWith('https://example.com')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Authenticated'))
  })

  it('passes --app-url flag value to startAppFlow', async () => {
    const tokenResponse = {
      accessToken: 'oauth-access-jwt',
      refreshToken: 'oauth-refresh-jwt',
      expiresAt: 8888888,
    }

    const mockStartOAuthFlow = vi.fn()
    const mockStartAppFlow = vi.fn().mockResolvedValue(tokenResponse)
    const mockLoginWithAccessCode = vi.fn()
    const mockCLIAdapter: ICLIAdapter = {
      startOAuthFlow: mockStartOAuthFlow,
      startAppFlow: mockStartAppFlow,
      loginWithAccessCode: mockLoginWithAccessCode,
    }
    const mockCLIFactory: CLIAdapterFactory = vi.fn().mockReturnValue(mockCLIAdapter)

    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    vi.stubEnv('DUOIDAL_APP_URL', '')

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin(['--app-url', 'http://localhost:5173'], mockCLIFactory)

    expect(mockStartAppFlow).toHaveBeenCalledWith('http://localhost:5173')
  })

  it('uses DUOIDAL_APP_URL env var when no --app-url flag is provided', async () => {
    const tokenResponse = {
      accessToken: 'oauth-access-jwt',
      refreshToken: 'oauth-refresh-jwt',
      expiresAt: 8888888,
    }

    const mockStartOAuthFlow = vi.fn()
    const mockStartAppFlow = vi.fn().mockResolvedValue(tokenResponse)
    const mockLoginWithAccessCode = vi.fn()
    const mockCLIAdapter: ICLIAdapter = {
      startOAuthFlow: mockStartOAuthFlow,
      startAppFlow: mockStartAppFlow,
      loginWithAccessCode: mockLoginWithAccessCode,
    }
    const mockCLIFactory: CLIAdapterFactory = vi.fn().mockReturnValue(mockCLIAdapter)

    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    vi.stubEnv('DUOIDAL_APP_URL', 'http://custom.example.com')

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin([], mockCLIFactory)

    expect(mockStartAppFlow).toHaveBeenCalledWith('http://custom.example.com')
  })

  it('falls back to https://example.com when no flag and no env var', async () => {
    const tokenResponse = {
      accessToken: 'oauth-access-jwt',
      refreshToken: 'oauth-refresh-jwt',
      expiresAt: 8888888,
    }

    const mockStartOAuthFlow = vi.fn()
    const mockStartAppFlow = vi.fn().mockResolvedValue(tokenResponse)
    const mockLoginWithAccessCode = vi.fn()
    const mockCLIAdapter: ICLIAdapter = {
      startOAuthFlow: mockStartOAuthFlow,
      startAppFlow: mockStartAppFlow,
      loginWithAccessCode: mockLoginWithAccessCode,
    }
    const mockCLIFactory: CLIAdapterFactory = vi.fn().mockReturnValue(mockCLIAdapter)

    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    vi.stubEnv('DUOIDAL_APP_URL', '')

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runLogin([], mockCLIFactory)

    expect(mockStartAppFlow).toHaveBeenCalledWith('https://example.com')
  })
})

// ---------------------------------------------------------------------------
// auth whoami
// ---------------------------------------------------------------------------

describe('auth whoami', () => {
  function makeJwt(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`
  }

  const REAL_UUID = '25337a89-cde3-4808-be8a-a576fb46a307'

  it('prints the email claim from the JWT payload', async () => {
    vi.mocked(config.readToken).mockReturnValue({ access_token: makeJwt({ email: 'user@example.com', sub: REAL_UUID }), refresh_token: '' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const cmd = authCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'duoidal', 'whoami'])

    expect(logSpy).toHaveBeenCalledWith('user@example.com')
  })

  it('falls back to sub claim when email is absent (sub is a UUID)', async () => {
    vi.mocked(config.readToken).mockReturnValue({ access_token: makeJwt({ sub: REAL_UUID }), refresh_token: '' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const cmd = authCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'duoidal', 'whoami'])

    expect(logSpy).toHaveBeenCalledWith(REAL_UUID)
  })

  it('rejects a fixture-style token (non-UUID sub)', async () => {
    // The exact fixture string that leaked from a vitest test into production
    // token files prior to PR #940. whoami must reject this loudly so a poisoned
    // token surfaces here instead of crashing downstream Postgres queries with
    // "invalid input syntax for type uuid".
    vi.mocked(config.readToken).mockReturnValue({ access_token: makeJwt({ sub: 'user-refresh-789' }), refresh_token: '' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)

    const cmd = authCommand()
    cmd.exitOverride()
    await expect(cmd.parseAsync(['node', 'duoidal', 'whoami'])).rejects.toThrow()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not a UUID'))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('duoidal auth login'))
    exitSpy.mockRestore()
  })

  it('exits with code 1 and error message when not authenticated', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)

    const cmd = authCommand()
    cmd.exitOverride()
    await expect(cmd.parseAsync(['node', 'duoidal', 'whoami'])).rejects.toThrow()

    expect(errorSpy).toHaveBeenCalledWith('Not logged in. Run: duoidal auth login')
    exitSpy.mockRestore()
  })

  it('exits with code 1 when token is malformed', async () => {
    vi.mocked(config.readToken).mockReturnValue({ access_token: 'not-a-jwt', refresh_token: '' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)

    const cmd = authCommand()
    cmd.exitOverride()
    await expect(cmd.parseAsync(['node', 'duoidal', 'whoami'])).rejects.toThrow()

    expect(errorSpy).toHaveBeenCalledWith('Failed to decode token')
    exitSpy.mockRestore()
  })

  it('exits with code 1 when token payload has no sub claim', async () => {
    vi.mocked(config.readToken).mockReturnValue({ access_token: makeJwt({ iat: 12345 }), refresh_token: '' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)

    const cmd = authCommand()
    cmd.exitOverride()
    await expect(cmd.parseAsync(['node', 'duoidal', 'whoami'])).rejects.toThrow()

    // No sub at all → the UUID check fails on undefined, surfacing the same
    // actionable error as a fixture-style sub.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not a UUID'))
    exitSpy.mockRestore()
  })
})
