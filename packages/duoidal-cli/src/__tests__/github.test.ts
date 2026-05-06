import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Top-level mock — hoisted before imports, so no variable references allowed in factory
vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>()
  return {
    ...actual,
    readToken: vi.fn(),
  }
})

import { githubCommand } from '../commands/github.js'
import type { ExecuteActionFn, SupabaseClientFactory } from '../commands/github.js'
import * as config from '../lib/config.js'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(config.readToken).mockReset()
})

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A valid JWT with sub claim (not verified, just decoded)
function makeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub, exp: 9999999999 })).toString('base64url')
  const sig = 'fake-sig'
  return `${header}.${payload}.${sig}`
}

function makeStoredToken(sub: string) {
  return {
    access_token: makeJwt(sub),
    refresh_token: 'refresh-token',
  }
}

// Build a mock supabase client that simulates a github_app link query
function makeMockSupabaseWithGithubLink(installationId: string): SupabaseClientFactory {
  let resourcesCallCount = 0
  const mockClient = {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'resources') {
        resourcesCallCount++
        const callNum = resourcesCallCount
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          // First call: user resource lookup → return user resource
          // Second call: credential resource lookup → return credential with installation_id
          limit: vi.fn().mockResolvedValue({
            data: callNum === 1
              ? [{ id: 'e46b5e28-c4bc-4b32-89d3-b20a51f1ddf9' }]
              : [{ config: { installation_id: installationId } }],
            error: null,
          }),
        }
      }
      if (table === 'resource_links') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [{ installation_id: installationId, link_type: 'github_app', from_id: 'gh-res', to_id: 'cred-res-xyz' }],
            error: null,
          }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      }
    }),
  }
  return vi.fn().mockReturnValue(mockClient)
}

// Build a mock supabase client with no github_app links
function makeMockSupabaseWithNoGithubLink(): SupabaseClientFactory {
  const mockClient = {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'resources') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [{ id: 'e46b5e28-c4bc-4b32-89d3-b20a51f1ddf9' }],
            error: null,
          }),
        }
      }
      if (table === 'resource_links') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      }
    }),
  }
  return vi.fn().mockReturnValue(mockClient)
}

// Run a subcommand under `github` with given args and optional injected factories
async function runGithub(
  args: string[],
  executeAction?: ExecuteActionFn,
  supabaseFactory?: SupabaseClientFactory
) {
  const cmd = githubCommand(executeAction, supabaseFactory)
  cmd.exitOverride()
  for (const sub of cmd.commands) {
    sub.exitOverride()
  }
  return cmd.parseAsync(['node', 'duoidal', ...args])
}

// ---------------------------------------------------------------------------
// 1. --help output
// ---------------------------------------------------------------------------

describe('github --help', () => {
  it('includes connect, status, and disconnect subcommands', () => {
    const cmd = githubCommand()
    const helpText = cmd.helpInformation()
    expect(helpText).toContain('connect')
    expect(helpText).toContain('status')
    expect(helpText).toContain('disconnect')
  })

  it('connect --help shows device flow instructions', () => {
    const cmd = githubCommand()
    const connectCmd = cmd.commands.find(c => c.name() === 'connect')
    expect(connectCmd).toBeDefined()
    const helpText = connectCmd!.helpInformation()
    expect(helpText).toContain('connect')
  })

  it('status --help describes the command', () => {
    const cmd = githubCommand()
    const statusCmd = cmd.commands.find(c => c.name() === 'status')
    expect(statusCmd).toBeDefined()
    const helpText = statusCmd!.helpInformation()
    expect(helpText).toContain('status')
  })
})

// ---------------------------------------------------------------------------
// 2. github status — GitHub connected
// ---------------------------------------------------------------------------

describe('github status — connected', () => {
  it('prints "GitHub connected" when github_app link exists', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000001'))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    // Stub service key to empty so the credential lookup uses the injected mock client,
    // not a new real client created with the live SUPABASE_SERVICE_KEY from env.
    vi.stubEnv('SUPABASE_SERVICE_KEY', '')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')

    const mockSupabaseFactory = makeMockSupabaseWithGithubLink('12345678')
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runGithub(['status'], undefined, mockSupabaseFactory)).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('GitHub connected'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('12345678'))
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 3. github status — GitHub not connected
// ---------------------------------------------------------------------------

describe('github status — not connected', () => {
  it('prints "GitHub not connected" when no github_app link exists', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000002'))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const mockSupabaseFactory = makeMockSupabaseWithNoGithubLink()
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runGithub(['status'], undefined, mockSupabaseFactory)).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith('GitHub not connected.')
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 4. github disconnect — not connected
// ---------------------------------------------------------------------------

describe('github disconnect — not connected', () => {
  it('prints "GitHub not connected." and exits 0 when no github_app link exists', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000003'))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const mockSupabaseFactory = makeMockSupabaseWithNoGithubLink()
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runGithub(['disconnect'], undefined, mockSupabaseFactory)).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith('GitHub not connected.')
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 5. github status — not logged in
// ---------------------------------------------------------------------------

describe('github status — not logged in', () => {
  it('prints error and exits 1 when no token is stored', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runGithub(['status'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith('Not logged in. Run: duoidal auth login')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})
