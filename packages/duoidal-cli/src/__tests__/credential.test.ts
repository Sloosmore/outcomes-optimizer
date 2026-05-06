import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Top-level mock — hoisted before imports
vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>()
  return {
    ...actual,
    readToken: vi.fn(),
    getSandboxKeyPath: vi.fn().mockReturnValue('/tmp/test-key'),
  }
})

vi.mock('../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/index.js')>()
  return {
    ...actual,
    resolveProvider: vi.fn(),
  }
})

import { linkCommand, unlinkCommand } from '../commands/credential.js'
import type { LinkCommandDeps, UnlinkCommandDeps } from '../commands/credential.js'
import * as config from '../lib/config.js'
import * as providers from '../providers/index.js'
import { UnknownProviderError } from '../providers/index.js'
import { SandboxUnreachableError } from '../providers/types.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJwt(sub: string, email = 'user@example.com'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub, email, exp: 9999999999 })).toString('base64url')
  return `${header}.${payload}.fake-sig`
}

function makeStoredToken(sub: string, email?: string) {
  return {
    access_token: makeJwt(sub, email),
    refresh_token: 'refresh-token',
  }
}

const FAKE_CREDENTIAL = 'sk-ant-super-secret-key-abc123xyz'
const SANDBOX_NAME = 'dev-1'
const SANDBOX_RESOURCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const USER_RESOURCE_ID = 'e46b5e28-c4bc-4b32-89d3-b20a51f1ddf9'
const SANDBOX_IP = '1.2.3.4'

// Build base deps used across tests
function makeMockSupabaseClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
    ...overrides,
  }
}

// Build mock supabase with fluent `.from().select().eq().eq().eq().eq()` returning no existing creds
function makeMockSupabaseWithNoExisting() {
  // The query chain: .from('resources').select('id, config').eq('type','credential').eq('auth_user_id', u).eq('config->>provider', p).eq('config->>sandboxName', s)
  // We need .eq() called 4 times; last call should return a Promise
  const makeChain = (resolveWith: { data: unknown[]; error: null }): {
    select: ReturnType<typeof vi.fn>
    eq: ReturnType<typeof vi.fn>
  } => {
    const chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn> } = {
      select: vi.fn(),
      eq: vi.fn(),
    }
    chain.select.mockReturnValue(chain)
    // First three eq calls return chain (fluent), last one resolves
    chain.eq
      .mockReturnValueOnce(chain)
      .mockReturnValueOnce(chain)
      .mockReturnValueOnce(chain)
      .mockReturnValue(Promise.resolve(resolveWith))
    return chain
  }

  const chain = makeChain({ data: [], error: null })

  return {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: vi.fn().mockReturnValue(chain),
  }
}

function makeMockSupabaseWithExistingCred() {
  const chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn> } = {
    select: vi.fn(),
    eq: vi.fn(),
  }
  chain.select.mockReturnValue(chain)
  chain.eq
    .mockReturnValueOnce(chain)
    .mockReturnValueOnce(chain)
    .mockReturnValueOnce(chain)
    .mockReturnValue(Promise.resolve({
      data: [{ id: 'cred-existing', config: { provider: 'github', sandboxName: SANDBOX_NAME } }],
      error: null,
    }))

  return {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: vi.fn().mockReturnValue(chain),
  }
}

function makeDeps(overrides: Partial<LinkCommandDeps> = {}): LinkCommandDeps {
  const mockExecuteAction = vi.fn()
    .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user
    .mockResolvedValueOnce({}) // store_user_credential (model) or whatever

  const mockSupabaseClient = makeMockSupabaseWithNoExisting()

  return {
    executeActionFactory: mockExecuteAction,
    supabaseFactory: vi.fn().mockReturnValue(mockSupabaseClient),
    findSandboxByNameFn: vi.fn().mockReturnValue(SANDBOX_RESOURCE_ID),
    readSandboxMetaFn: vi.fn().mockReturnValue({
      serverResourceId: SANDBOX_RESOURCE_ID,
      serverName: SANDBOX_NAME,
      status: 'active',
      ip: SANDBOX_IP,
    }),
    getSandboxKeyPathFn: vi.fn().mockReturnValue('/tmp/test-key'),
    ...overrides,
  }
}

let credentialFilePath: string
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-cred-test-'))
  credentialFilePath = path.join(tmpDir, 'cred.txt')
  fs.writeFileSync(credentialFilePath, `${FAKE_CREDENTIAL}\n`, { mode: 0o600 })

  vi.mocked(config.readToken).mockReturnValue(makeStoredToken('0dfb6bb7-797a-4836-88d7-5b0dac2b2707'))
  vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

async function runLink(args: string[], deps?: LinkCommandDeps) {
  const cmd = linkCommand(deps)
  cmd.exitOverride()
  return cmd.parseAsync(['node', 'duoidal', ...args])
}

// ---------------------------------------------------------------------------
// 1. Happy path: anthropic link
// ---------------------------------------------------------------------------

describe('link — anthropic happy path', () => {
  it('vaults credential and calls adapter.link; prints success without credential', async () => {
    const mockAdapterLink = vi.fn().mockResolvedValue(undefined)
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'anthropic',
      category: 'model',
      link: mockAdapterLink,
      unlink: vi.fn(),
    })

    const mockExecuteAction = vi.fn()
      .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user
      .mockResolvedValueOnce({}) // store_user_credential

    const deps = makeDeps({ executeActionFactory: mockExecuteAction })

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runLink([
      '--provider', 'anthropic',
      '--sandbox', SANDBOX_NAME,
      '--credential-file', credentialFilePath,
    ], deps)

    // store_user_credential called with correct input
    const calls = mockExecuteAction.mock.calls
    const storeCalls = calls.filter(([name]) => name === 'store_user_credential')
    expect(storeCalls.length).toBe(1)
    expect(storeCalls[0]![1]).toMatchObject({
      userResourceId: USER_RESOURCE_ID,
      sandboxName: SANDBOX_NAME,
      provider: 'anthropic',
      credentialValue: FAKE_CREDENTIAL,
    })

    // adapter.link called with sandbox info
    expect(mockAdapterLink).toHaveBeenCalledWith(expect.objectContaining({
      credential: FAKE_CREDENTIAL,
      sandbox: { ip: SANDBOX_IP, keyPath: '/tmp/test-key' },
      userResourceId: USER_RESOURCE_ID,
      sandboxName: SANDBOX_NAME,
    }))

    // success output
    const allLogs = consoleSpy.mock.calls.map(args => args.join(' ')).join('\n')
    expect(allLogs).toContain('Linked anthropic')
    expect(allLogs).toContain(SANDBOX_NAME)

    // credential NOT in any output
    const allOutput = [
      ...consoleSpy.mock.calls.map(a => a.join(' ')),
      ...consoleErrSpy.mock.calls.map(a => a.join(' ')),
    ].join('\n')
    expect(allOutput).not.toContain(FAKE_CREDENTIAL)

    stdoutSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 2. Happy path: github link
// ---------------------------------------------------------------------------

describe('link — github happy path', () => {
  it('calls adapter.link without store_user_credential; prints success', async () => {
    const mockAdapterLink = vi.fn().mockResolvedValue(undefined)
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'github',
      category: 'tool',
      link: mockAdapterLink,
      unlink: vi.fn(),
    })

    const mockExecuteAction = vi.fn()
      .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user
    // No second call expected for tool providers

    const deps = makeDeps({ executeActionFactory: mockExecuteAction })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runLink([
      '--provider', 'github',
      '--sandbox', SANDBOX_NAME,
      '--credential-file', credentialFilePath,
    ], deps)

    // store_user_credential NOT called for tool providers
    const storeCalls = mockExecuteAction.mock.calls.filter(([name]) => name === 'store_user_credential')
    expect(storeCalls.length).toBe(0)

    // adapter.link called
    expect(mockAdapterLink).toHaveBeenCalledWith(expect.objectContaining({
      credential: FAKE_CREDENTIAL,
      userResourceId: USER_RESOURCE_ID,
    }))

    // success output
    const allLogs = consoleSpy.mock.calls.map(args => args.join(' ')).join('\n')
    expect(allLogs).toContain('Linked github')

    // credential NOT in any output
    const allOutput = [
      ...consoleSpy.mock.calls.map(a => a.join(' ')),
      ...consoleErrSpy.mock.calls.map(a => a.join(' ')),
    ].join('\n')
    expect(allOutput).not.toContain(FAKE_CREDENTIAL)
  })
})

// ---------------------------------------------------------------------------
// 3. Unknown provider
// ---------------------------------------------------------------------------

describe('link — unknown provider', () => {
  it('exits 1 with "Unknown provider" error and writes no credentials', async () => {
    vi.mocked(providers.resolveProvider).mockImplementation((name: string) => {
      throw new UnknownProviderError(name)
    })

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    const deps = makeDeps()

    await expect(runLink([
      '--provider', 'unknown-provider',
      '--sandbox', SANDBOX_NAME,
      '--credential-file', credentialFilePath,
    ], deps)).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput).toContain('Unknown provider')

    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 4. Already linked (model provider)
// ---------------------------------------------------------------------------

describe('link — already linked (model provider)', () => {
  it('exits 1 with "already linked" and "unlink" message when vault RPC returns P0001', async () => {
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'anthropic',
      category: 'model',
      link: vi.fn(),
      unlink: vi.fn(),
    })

    const mockExecuteAction = vi.fn()
      .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user
      .mockRejectedValueOnce(new Error('Already linked [P0001]')) // store_user_credential

    const deps = makeDeps({ executeActionFactory: mockExecuteAction })

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runLink([
      '--provider', 'anthropic',
      '--sandbox', SANDBOX_NAME,
      '--credential-file', credentialFilePath,
    ], deps)).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput.toLowerCase()).toContain('already linked')
    expect(errOutput).toContain('unlink')

    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 5. Already linked (tool provider)
// ---------------------------------------------------------------------------

describe('link — already linked (tool provider)', () => {
  it('exits 1 with "already linked" when supabase query returns existing credential', async () => {
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'github',
      category: 'tool',
      link: vi.fn(),
      unlink: vi.fn(),
    })

    const mockExecuteAction = vi.fn()
      .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user

    const mockSupabaseClient = makeMockSupabaseWithExistingCred()
    const deps = makeDeps({
      executeActionFactory: mockExecuteAction,
      supabaseFactory: vi.fn().mockReturnValue(mockSupabaseClient),
    })

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runLink([
      '--provider', 'github',
      '--sandbox', SANDBOX_NAME,
      '--credential-file', credentialFilePath,
    ], deps)).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput.toLowerCase()).toContain('already linked')

    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 6. Missing credential file
// ---------------------------------------------------------------------------

describe('link — missing credential file', () => {
  it('exits 1 when credential file does not exist', async () => {
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'anthropic',
      category: 'model',
      link: vi.fn(),
      unlink: vi.fn(),
    })

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    const deps = makeDeps()

    await expect(runLink([
      '--provider', 'anthropic',
      '--sandbox', SANDBOX_NAME,
      '--credential-file', '/nonexistent/path/to/cred.txt',
    ], deps)).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput.toLowerCase()).toContain('credential file')

    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 7. Sandbox not found
// ---------------------------------------------------------------------------

describe('link — sandbox not found', () => {
  it('exits 1 when findSandboxByName returns null', async () => {
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'anthropic',
      category: 'model',
      link: vi.fn(),
      unlink: vi.fn(),
    })

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    const deps = makeDeps({
      findSandboxByNameFn: vi.fn().mockReturnValue(null),
    })

    await expect(runLink([
      '--provider', 'anthropic',
      '--sandbox', 'nonexistent-sandbox',
      '--credential-file', credentialFilePath,
    ], deps)).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput).toContain('nonexistent-sandbox')

    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 8. Security test: credential NOT in any output
// ---------------------------------------------------------------------------

describe('link — security: credential not in output', () => {
  it('does not print the credential value in stdout or stderr', async () => {
    const mockAdapterLink = vi.fn().mockResolvedValue(undefined)
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'anthropic',
      category: 'model',
      link: mockAdapterLink,
      unlink: vi.fn(),
    })

    const mockExecuteAction = vi.fn()
      .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID })
      .mockResolvedValueOnce({})

    const deps = makeDeps({ executeActionFactory: mockExecuteAction })

    const capturedLogs: string[] = []
    const capturedErrors: string[] = []
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      capturedLogs.push(args.join(' '))
    })
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      capturedErrors.push(args.join(' '))
    })

    await runLink([
      '--provider', 'anthropic',
      '--sandbox', SANDBOX_NAME,
      '--credential-file', credentialFilePath,
    ], deps)

    const allOutput = [...capturedLogs, ...capturedErrors].join('\n')
    expect(allOutput).not.toContain(FAKE_CREDENTIAL)

    consoleSpy.mockRestore()
    consoleErrSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 9. Not logged in
// ---------------------------------------------------------------------------

describe('link — not logged in', () => {
  it('exits 1 with login error', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runLink([
      '--provider', 'anthropic',
      '--sandbox', SANDBOX_NAME,
      '--credential-file', credentialFilePath,
    ])).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput).toContain('Not logged in')

    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Unlink helpers
// ---------------------------------------------------------------------------

const CRED_RESOURCE_ID = 'cred-res-id'

/**
 * Build a fluent supabase mock for the unlink credential query.
 * Chain: .from('resources').select('id').eq('type','credential').eq('config->>provider', p).eq('config->>sandboxName', s)
 * resolveWith is what the last .eq() call returns as a Promise.
 */
function makeMockSupabaseForUnlink(resolveWith: { data: unknown[]; error: null }) {
  const chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn> } = {
    select: vi.fn(),
    eq: vi.fn(),
  }
  chain.select.mockReturnValue(chain)
  // 4 eq calls: first three return chain (fluent), last returns the Promise
  // (.eq type, .eq auth_user_id, .eq provider, .eq sandboxName)
  chain.eq
    .mockReturnValueOnce(chain)
    .mockReturnValueOnce(chain)
    .mockReturnValueOnce(chain)
    .mockReturnValue(Promise.resolve(resolveWith))

  return {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: vi.fn().mockReturnValue(chain),
  }
}

function makeUnlinkDeps(overrides: Partial<UnlinkCommandDeps> = {}): UnlinkCommandDeps {
  const mockSupabaseClient = makeMockSupabaseForUnlink({ data: [{ id: CRED_RESOURCE_ID }], error: null })

  const mockExecuteAction = vi.fn()
    .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user
    .mockResolvedValueOnce({}) // delete_user_credential

  return {
    executeActionFactory: mockExecuteAction,
    supabaseFactory: vi.fn().mockReturnValue(mockSupabaseClient),
    findSandboxByNameFn: vi.fn().mockReturnValue(SANDBOX_RESOURCE_ID),
    readSandboxMetaFn: vi.fn().mockReturnValue({
      serverResourceId: SANDBOX_RESOURCE_ID,
      serverName: SANDBOX_NAME,
      status: 'active',
      ip: SANDBOX_IP,
    }),
    getSandboxKeyPathFn: vi.fn().mockReturnValue('/tmp/test-key'),
    ...overrides,
  }
}

async function runUnlink(args: string[], deps?: UnlinkCommandDeps) {
  const cmd = unlinkCommand(deps)
  cmd.exitOverride()
  return cmd.parseAsync(['node', 'duoidal', ...args])
}

// ---------------------------------------------------------------------------
// 10. Unlink anthropic — happy path
// ---------------------------------------------------------------------------

describe('unlink — anthropic happy path', () => {
  it('calls adapter.unlink then delete_user_credential; prints Unlinked', async () => {
    const unlinkCallOrder: string[] = []

    const mockAdapterUnlink = vi.fn().mockImplementation(async () => {
      unlinkCallOrder.push('adapter.unlink')
    })
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'anthropic',
      category: 'model',
      link: vi.fn(),
      unlink: mockAdapterUnlink,
    })

    const mockExecuteAction = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'provision_user') return { userResourceId: USER_RESOURCE_ID }
      if (name === 'delete_user_credential') {
        unlinkCallOrder.push('delete_user_credential')
        return {}
      }
      return {}
    })

    const deps = makeUnlinkDeps({ executeActionFactory: mockExecuteAction })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runUnlink(['--provider', 'anthropic', '--sandbox', SANDBOX_NAME], deps)

    // adapter.unlink called with sandbox info
    expect(mockAdapterUnlink).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: { ip: SANDBOX_IP, keyPath: '/tmp/test-key' },
    }))

    // delete_user_credential called AFTER adapter.unlink
    expect(unlinkCallOrder).toEqual(['adapter.unlink', 'delete_user_credential'])

    // delete_user_credential called with credentialResourceId
    const deleteCalls = mockExecuteAction.mock.calls.filter(([name]) => name === 'delete_user_credential')
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0]![1]).toMatchObject({ credentialResourceId: CRED_RESOURCE_ID })

    const allLogs = consoleSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(allLogs).toContain('Unlinked anthropic')
  })
})

// ---------------------------------------------------------------------------
// 11. Unlink anthropic — not linked
// ---------------------------------------------------------------------------

describe('unlink — anthropic not linked', () => {
  it('prints not linked message and exits 0', async () => {
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'anthropic',
      category: 'model',
      link: vi.fn(),
      unlink: vi.fn(),
    })

    const mockSupabaseClient = makeMockSupabaseForUnlink({ data: [], error: null })
    const mockExecuteAction = vi.fn()
      .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user

    const deps = makeUnlinkDeps({
      executeActionFactory: mockExecuteAction,
      supabaseFactory: vi.fn().mockReturnValue(mockSupabaseClient),
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runUnlink(['--provider', 'anthropic', '--sandbox', SANDBOX_NAME], deps)

    const allLogs = consoleSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(allLogs).toContain('anthropic: not linked to sandbox')
    expect(allLogs).toContain(SANDBOX_NAME)

    // delete_user_credential NOT called
    const deleteCalls = mockExecuteAction.mock.calls.filter(([name]) => name === 'delete_user_credential')
    expect(deleteCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 12. Unlink anthropic — SSH unreachable (SC-7)
// ---------------------------------------------------------------------------

describe('unlink — anthropic SSH unreachable', () => {
  it('exits 1 with unreachable message and does NOT call delete_user_credential', async () => {
    const mockAdapterUnlink = vi.fn().mockRejectedValue(new SandboxUnreachableError(SANDBOX_IP))
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'anthropic',
      category: 'model',
      link: vi.fn(),
      unlink: mockAdapterUnlink,
    })

    const mockExecuteAction = vi.fn()
      .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user

    const deps = makeUnlinkDeps({ executeActionFactory: mockExecuteAction })

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runUnlink(['--provider', 'anthropic', '--sandbox', SANDBOX_NAME], deps)).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput.toLowerCase()).toContain('unreachable')

    // delete_user_credential must NOT have been called
    const deleteCalls = mockExecuteAction.mock.calls.filter(([name]) => name === 'delete_user_credential')
    expect(deleteCalls.length).toBe(0)

    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 13. Unlink github — happy path
// ---------------------------------------------------------------------------

describe('unlink — github happy path', () => {
  it('calls adapter.unlink with executeAction; executeAction calls delete_user_credential; prints Unlinked', async () => {
    const mockAdapterUnlink = vi.fn().mockImplementation(async (opts: { executeAction: (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>; credentialResourceId: string; supabaseClient: unknown }) => {
      await opts.executeAction('delete_user_credential', { credentialResourceId: opts.credentialResourceId }, opts.supabaseClient)
    })
    vi.mocked(providers.resolveProvider).mockReturnValue({
      provider: 'github',
      category: 'tool',
      link: vi.fn(),
      unlink: mockAdapterUnlink,
    })

    const mockExecuteAction = vi.fn()
      .mockResolvedValueOnce({ userResourceId: USER_RESOURCE_ID }) // provision_user
      .mockResolvedValueOnce({}) // delete_user_credential (called via adapter)

    const deps = makeUnlinkDeps({ executeActionFactory: mockExecuteAction })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runUnlink(['--provider', 'github', '--sandbox', SANDBOX_NAME], deps)

    // adapter.unlink was called
    expect(mockAdapterUnlink).toHaveBeenCalledWith(expect.objectContaining({
      credentialResourceId: CRED_RESOURCE_ID,
    }))

    // delete_user_credential was called (via adapter)
    const deleteCalls = mockExecuteAction.mock.calls.filter(([name]) => name === 'delete_user_credential')
    expect(deleteCalls.length).toBe(1)

    const allLogs = consoleSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(allLogs).toContain('Unlinked github')
  })
})

// ---------------------------------------------------------------------------
// 14. Unlink — unknown provider
// ---------------------------------------------------------------------------

describe('unlink — unknown provider', () => {
  it('exits 1 with Unknown provider message', async () => {
    vi.mocked(providers.resolveProvider).mockImplementation((name: string) => {
      throw new UnknownProviderError(name)
    })

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    const deps = makeUnlinkDeps()

    await expect(runUnlink(['--provider', 'not-a-provider', '--sandbox', SANDBOX_NAME], deps)).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput).toContain('Unknown provider')

    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 15. Unlink — not logged in
// ---------------------------------------------------------------------------

describe('unlink — not logged in', () => {
  it('exits 1 with Not logged in message', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runUnlink(['--provider', 'anthropic', '--sandbox', SANDBOX_NAME])).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = consoleErrSpy.mock.calls.map(a => a.join(' ')).join('\n')
    expect(errOutput).toContain('Not logged in')

    exitSpy.mockRestore()
  })
})
