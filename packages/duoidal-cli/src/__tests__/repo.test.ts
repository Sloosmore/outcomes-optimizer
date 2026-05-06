import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Ajv } from 'ajv'

// Top-level mock — hoisted before imports, so no variable references allowed in factory
vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>()
  return {
    ...actual,
    readToken: vi.fn(),
  }
})

import { repoCommand } from '../commands/repo.js'
import type { ExecuteActionFn, SupabaseClientFactory } from '../commands/repo.js'
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

// Build a mock supabase client for repo list with repos data.
//
// The mock simulates the real schema constraint that broke `repo list` in
// production: a user resource row is keyed by (auth_user_id, type='user').
// The row's `name` is NOT stable across history — older rows are
// 'user:<email_local>', newer rows are 'user:<auth_user_id>'. So a query
// filtered on `name = 'user:<sub>'` will miss any pre-04-21 user.
//
// This mock returns the row only when the read filters on the SAME field as
// the write path (`auth_user_id`). Filtering on `name` returns null,
// reproducing the production failure mode.
function makeMockSupabaseWithRepos(
  repos: Array<{ owner: string; name: string; default?: boolean }>,
  opts?: { storedAuthUserId?: string; storedName?: string }
): SupabaseClientFactory {
  const storedAuthUserId = opts?.storedAuthUserId
  const storedName = opts?.storedName
  const mockClient = {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: vi.fn().mockImplementation((_table: string) => {
      const filters: Record<string, unknown> = {}
      const builder: Record<string, unknown> = {
        select: vi.fn(() => builder),
        eq: vi.fn((col: string, val: unknown) => {
          filters[col] = val
          return builder
        }),
        single: vi.fn(async () => {
          const matchesAuth = storedAuthUserId !== undefined
            ? filters['auth_user_id'] === storedAuthUserId
            : true
          const matchesName = storedName !== undefined
            ? filters['name'] === storedName
            : true
          // The query must hit at least one of the keyed filters and the
          // value must match what's stored. If neither filter is set or the
          // values don't match, no row is returned (mirrors PostgREST).
          const usedAuthFilter = 'auth_user_id' in filters
          const usedNameFilter = 'name' in filters
          if ((usedAuthFilter && matchesAuth) || (usedNameFilter && matchesName)) {
            return { data: { config: { repos } }, error: null }
          }
          return { data: null, error: { code: 'PGRST116', message: 'not found' } }
        }),
      }
      return builder
    }),
  }
  return vi.fn().mockReturnValue(mockClient)
}

// Build a mock supabase client for add/remove (executeAction-based)
function makeMockSupabaseSimple(): SupabaseClientFactory {
  const mockClient = {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: vi.fn().mockImplementation((_table: string) => {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { config: { repos: [] } }, error: null }),
      }
    }),
  }
  return vi.fn().mockReturnValue(mockClient)
}

// Run a subcommand under `repo` with given args and optional injected factories
async function runRepo(
  args: string[],
  executeAction?: ExecuteActionFn,
  supabaseFactory?: SupabaseClientFactory
) {
  const cmd = repoCommand(executeAction, supabaseFactory)
  cmd.exitOverride()
  for (const sub of cmd.commands) {
    sub.exitOverride()
  }
  return cmd.parseAsync(['node', 'duoidal', ...args])
}

// ---------------------------------------------------------------------------
// 1. --help output
// ---------------------------------------------------------------------------

describe('repo --help', () => {
  it('includes add, list, and remove subcommands', () => {
    const cmd = repoCommand()
    const helpText = cmd.helpInformation()
    expect(helpText).toContain('add')
    expect(helpText).toContain('list')
    expect(helpText).toContain('remove')
  })
})

// ---------------------------------------------------------------------------
// 2. repo add owner/name
// ---------------------------------------------------------------------------

describe('repo add', () => {
  it('calls executeAction with correct params for owner/name positional arg', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000001'))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const mockExecuteAction: ExecuteActionFn = vi.fn().mockResolvedValue({})
    const mockSupabaseFactory = makeMockSupabaseSimple()
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runRepo(['add', 'myorg/myrepo'], mockExecuteAction, mockSupabaseFactory)

    expect(mockExecuteAction).toHaveBeenCalledWith(
      'add_user_repo',
      expect.objectContaining({ owner: 'myorg', name: 'myrepo' }),
      expect.anything()
    )
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('myorg/myrepo'))
  })

  it('calls executeAction with default flag when --default is passed', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000001'))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const mockExecuteAction: ExecuteActionFn = vi.fn().mockResolvedValue({})
    const mockSupabaseFactory = makeMockSupabaseSimple()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runRepo(['add', 'myorg/myrepo', '--default'], mockExecuteAction, mockSupabaseFactory)

    expect(mockExecuteAction).toHaveBeenCalledWith(
      'add_user_repo',
      expect.objectContaining({ owner: 'myorg', name: 'myrepo', default: true }),
      expect.anything()
    )
  })
})

// ---------------------------------------------------------------------------
// 3. repo list — prints repos
// ---------------------------------------------------------------------------

describe('repo list — with repos', () => {
  it('prints repos from mock Supabase query', async () => {
    const sub = '00000000-0000-4000-8000-000000000001'
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken(sub))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const mockSupabaseFactory = makeMockSupabaseWithRepos(
      [
        { owner: 'myorg', name: 'myrepo', default: true },
        { owner: 'myorg', name: 'otherrepo' },
      ],
      { storedAuthUserId: sub }
    )
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runRepo(['list'], undefined, mockSupabaseFactory)

    expect(consoleSpy).toHaveBeenCalledWith('myorg/myrepo (default)')
    expect(consoleSpy).toHaveBeenCalledWith('myorg/otherrepo')
  })
})

// ---------------------------------------------------------------------------
// 4. repo list — empty
// ---------------------------------------------------------------------------

describe('repo list — empty', () => {
  it('prints "No repos configured." when repos array is empty', async () => {
    const sub = '00000000-0000-4000-8000-000000000001'
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken(sub))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const mockSupabaseFactory = makeMockSupabaseWithRepos([], { storedAuthUserId: sub })
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runRepo(['list'], undefined, mockSupabaseFactory)

    expect(consoleSpy).toHaveBeenCalledWith('No repos configured.')
  })
})

// ---------------------------------------------------------------------------
// 4b. Guard — `repo list` must read by auth_user_id, not by name
// ---------------------------------------------------------------------------
//
// Regression test for the symmetric drift fixed alongside PR #989. The write
// path (add_user_repo / remove_user_repo) resolves the user resource via
// app.current_user_resource_id(), which filters on auth_user_id. For users
// provisioned before migration 20260421000001, the resource `name` is
// 'user:<email_local>', not 'user:<sub>'. A name-based read therefore misses
// those rows and reports "No repos configured." even after a successful add.
//
// The mock here writes a row stored under (auth_user_id=<sub>, name='user:alice')
// — i.e., the email-local-part shape — so a name-based lookup with
// 'user:<sub>' returns null, while an auth_user_id-based lookup succeeds.
// If the CLI ever regresses to a name-based filter, this test fails.
describe('repo list — round-trip with email-local-part user name', () => {
  it('finds the user resource via auth_user_id even when name uses email-local-part', async () => {
    const sub = '00000000-0000-4000-8000-000000000001'
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken(sub))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    // Row exists with the legacy email-local-part name. A read by
    // `name = 'user:<sub>'` would return null (the production failure mode).
    // The mock only returns data when the auth_user_id filter matches.
    const mockSupabaseFactory = makeMockSupabaseWithRepos(
      [{ owner: 'myorg', name: 'myrepo', default: true }],
      { storedAuthUserId: sub, storedName: 'user:alice' }
    )
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runRepo(['list'], undefined, mockSupabaseFactory)

    expect(consoleSpy).toHaveBeenCalledWith('myorg/myrepo (default)')
    expect(consoleSpy).not.toHaveBeenCalledWith('No repos configured.')
  })

  it('round-trip: a successful add followed by list returns the added repo', async () => {
    const sub = '00000000-0000-4000-8000-000000000001'
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken(sub))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    // Shared "DB state" — what add_user_repo would write. Keyed only by
    // auth_user_id (the canonical write-path lookup); the row's name uses
    // the legacy email-local-part shape to mirror pre-04-21 production rows.
    const dbRepos: Array<{ owner: string; name: string; default?: boolean }> = []

    const mockExecuteAction: ExecuteActionFn = vi.fn(async (actionName, input) => {
      if (actionName === 'add_user_repo') {
        const owner = input['owner'] as string
        const name = input['name'] as string
        const isDefault = input['default'] as boolean | undefined
        dbRepos.push({ owner, name, ...(isDefault ? { default: true } : {}) })
      }
      return {}
    })

    const mockSupabaseFactory = makeMockSupabaseWithRepos(
      dbRepos,
      { storedAuthUserId: sub, storedName: 'user:alice' }
    )
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runRepo(['add', 'myorg/myrepo'], mockExecuteAction, mockSupabaseFactory)
    await runRepo(['list'], mockExecuteAction, mockSupabaseFactory)

    expect(consoleSpy).toHaveBeenCalledWith('Repo added: myorg/myrepo')
    expect(consoleSpy).toHaveBeenCalledWith('myorg/myrepo')
    expect(consoleSpy).not.toHaveBeenCalledWith('No repos configured.')
  })
})

// ---------------------------------------------------------------------------
// 5. repo remove owner/name
// ---------------------------------------------------------------------------

describe('repo remove', () => {
  it('calls executeAction with correct params for owner/name positional arg', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000001'))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const mockExecuteAction: ExecuteActionFn = vi.fn().mockResolvedValue({})
    const mockSupabaseFactory = makeMockSupabaseSimple()
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runRepo(['remove', 'myorg/myrepo'], mockExecuteAction, mockSupabaseFactory)

    expect(mockExecuteAction).toHaveBeenCalledWith(
      'remove_user_repo',
      expect.objectContaining({ owner: 'myorg', name: 'myrepo' }),
      expect.anything()
    )
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('myorg/myrepo'))
  })
})

// ---------------------------------------------------------------------------
// 6. Not logged in
// ---------------------------------------------------------------------------

describe('repo — not logged in', () => {
  it('prints error and exits 1 when no token is stored (add)', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runRepo(['add', 'myorg/myrepo'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Not logged in'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('prints error and exits 1 when no token is stored (list)', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runRepo(['list'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Not logged in'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('prints error and exits 1 when no token is stored (remove)', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runRepo(['remove', 'myorg/myrepo'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Not logged in'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 7. Guard: CLI payload shape conforms to action input schema
// ---------------------------------------------------------------------------
//
// Why this test exists: the previous unit tests above mock executeAction and
// only check the call args, so they enshrine whatever shape repo.ts happens to
// send — including a buggy one. The rpc-matrix integration tests bypass the
// action validator entirely by calling RPCs with snake_case params directly.
// Neither path exercised CLI -> executeAction -> action validator, which is
// how the `userResourceId` regression slipped through (broken since the
// 2026-04-21 identity-layer migration).
//
// This test mirrors the canonical input schemas from
// supabase/migrations/20260421000001_identity_layer.sql (add_user_repo /
// remove_user_repo) and validates the CLI's actual payload against AJV with
// the same options the real validator uses (`additionalProperties: false`).
// If repo.ts regrows `userResourceId` (or any other extra field), AJV will
// reject the payload and this test will fail closed.
//
// If the migration's input schema changes, mirror the change here. The schema
// is the source of truth; this test is a drift detector.

const ADD_USER_REPO_INPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['owner', 'name'],
  properties: {
    owner: { type: 'string' },
    name: { type: 'string' },
    default: { type: 'boolean' },
  },
  additionalProperties: false,
} as const

const REMOVE_USER_REPO_INPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['owner', 'name'],
  properties: {
    owner: { type: 'string' },
    name: { type: 'string' },
  },
  additionalProperties: false,
} as const

describe('repo — payload conforms to action input schema', () => {
  async function captureExecuteActionPayload(args: string[]): Promise<{ name: string; input: Record<string, unknown> }> {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000001'))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    let captured: { name: string; input: Record<string, unknown> } | null = null
    const mockExecuteAction: ExecuteActionFn = vi.fn().mockImplementation(async (name: string, input: Record<string, unknown>) => {
      captured = { name, input }
      return {}
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runRepo(args, mockExecuteAction, makeMockSupabaseSimple())
    if (!captured) throw new Error('executeAction was not called')
    return captured
  }

  it('add: payload validates against add_user_repo input schema', async () => {
    const ajv = new Ajv({ allErrors: true })
    const validate = ajv.compile(ADD_USER_REPO_INPUT_SCHEMA)

    const { name, input } = await captureExecuteActionPayload(['add', 'myorg/myrepo'])
    expect(name).toBe('add_user_repo')

    const valid = validate(input)
    if (!valid) {
      throw new Error(`Payload rejected by schema: ${JSON.stringify(validate.errors)} — payload was ${JSON.stringify(input)}`)
    }
    expect(valid).toBe(true)
  })

  it('add --default: payload validates against add_user_repo input schema', async () => {
    const ajv = new Ajv({ allErrors: true })
    const validate = ajv.compile(ADD_USER_REPO_INPUT_SCHEMA)

    const { input } = await captureExecuteActionPayload(['add', 'myorg/myrepo', '--default'])

    const valid = validate(input)
    if (!valid) {
      throw new Error(`Payload rejected by schema: ${JSON.stringify(validate.errors)} — payload was ${JSON.stringify(input)}`)
    }
    expect(valid).toBe(true)
  })

  it('remove: payload validates against remove_user_repo input schema', async () => {
    const ajv = new Ajv({ allErrors: true })
    const validate = ajv.compile(REMOVE_USER_REPO_INPUT_SCHEMA)

    const { name, input } = await captureExecuteActionPayload(['remove', 'myorg/myrepo'])
    expect(name).toBe('remove_user_repo')

    const valid = validate(input)
    if (!valid) {
      throw new Error(`Payload rejected by schema: ${JSON.stringify(validate.errors)} — payload was ${JSON.stringify(input)}`)
    }
    expect(valid).toBe(true)
  })
})
