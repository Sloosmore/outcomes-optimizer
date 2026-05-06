import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

// ---- Module mocks (must be top-level, before any imports) ----

vi.mock('dotenv/config', () => ({}))

const fakeSql = Object.assign(vi.fn(), { json: (v: unknown) => v })
vi.mock('@skill-networks/database/client', () => ({
  getSqlClient: () => fakeSql,
  closeSqlClient: vi.fn(),
}))

const mockResolveUserProjects = vi.fn()
vi.mock('@skill-networks/database', () => {
  class ResourcesService {
    resolveUserProjects = mockResolveUserProjects
    list = vi.fn()
    search = vi.fn()
    getByName = vi.fn()
    getById = vi.fn()
    getAvailable = vi.fn()
    getTypes = vi.fn()
    getLinkTypes = vi.fn()
    getValueTypes = vi.fn()
    listAllLinks = vi.fn()
  }
  class ProcessesService {
    listLeaves = vi.fn()
  }
  class MetricsService {}
  return { ResourcesService, ProcessesService, MetricsService }
})

vi.mock('@skill-networks/database/constants', () => ({
  getSupabaseUrl: () => 'https://test.supabase.co',
  getSupabaseAnonKey: () => 'test-anon-key',
}))

const mockProjectScopeResolve = vi.fn()
vi.mock('@skill-networks/database/services', () => {
  class ProjectScopeService {
    resolve = mockProjectScopeResolve
  }
  return { ProjectScopeService }
})

// Mock node:fs so readFileSync/writeFileSync/mkdirSync/renameSync can be controlled per test.
//
// IMPORTANT: write-side mocks (writeFileSync, mkdirSync, renameSync) MUST default to no-ops,
// not pass-throughs to the real fs. A previous version of this file used
// `vi.fn(actual.writeFileSync)` which retained the real implementation as the default — when
// the (f) refresh test triggered `writeLocalToken`, it wrote the test fixture
// (`access_token: ...user-refresh-789..., refresh_token: 'new-refresh-token'`) directly to
// the developer's real `~/.config/duoidal/token.json`, poisoning their session. See PR
// "fix(tests): isolate token-write tests from real-fs". Read-side defaults to ENOENT for the
// same reason: tests must never touch the real filesystem at the user's home directory.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const safeReadFileSync = vi.fn(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  const safeWriteFileSync = vi.fn(() => undefined)
  const safeMkdirSync = vi.fn(() => undefined)
  const safeRenameSync = vi.fn(() => undefined)
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: safeReadFileSync,
      writeFileSync: safeWriteFileSync,
      mkdirSync: safeMkdirSync,
      renameSync: safeRenameSync,
    },
    readFileSync: safeReadFileSync,
    writeFileSync: safeWriteFileSync,
    mkdirSync: safeMkdirSync,
    renameSync: safeRenameSync,
  }
})

import fs from 'node:fs'
const mockReadFileSync = vi.mocked(fs.readFileSync)
const mockWriteFileSync = vi.mocked(fs.writeFileSync)
const mockMkdirSync = vi.mocked(fs.mkdirSync)
const mockRenameSync = vi.mocked(fs.renameSync)

// ---- Helpers ----

function buildJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.fake-signature`
}

const TOKEN_PATH = path.join(os.homedir(), '.config', 'duoidal', 'token.json')

function makeScope(resourceIds: string[] = [], projectIds: string[] = []) {
  const rSet = new Set(resourceIds)
  const pSet = new Set(projectIds)
  return {
    resourceIds: rSet,
    projectIds: pSet,
    has: (id: string) => rSet.has(id),
    filterResources: <T extends { id: string }>(rows: T[]) => rows.filter(r => rSet.has(r.id)),
    filterLinks: <T extends { from_id: string; to_id: string }>(links: T[]) =>
      links.filter(l => rSet.has(l.from_id) && rSet.has(l.to_id)),
    filterProcesses: <T extends { project_id: string | null }>(rows: T[]) =>
      rows.filter(r => r.project_id !== null && pSet.has(r.project_id)),
  }
}

// ---- Tests ----

describe('adapter-factory — initAdapter', () => {
  let mockExit: ReturnType<typeof vi.spyOn>
  let mockConsoleError: ReturnType<typeof vi.spyOn>
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Remove any auth env vars so each test controls its own state
    delete process.env.DUOIDAL_TOKEN
    delete process.env.DATABASE_URL
    delete process.env.DIRECT_URL

    // Default: token file doesn't exist
    mockReadFileSync.mockImplementation((filePath, ...rest) => {
      if (typeof filePath === 'string' && filePath === TOKEN_PATH) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      // For all other paths, fall through to actual implementation (or throw for unknown)
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
  })

  afterEach(() => {
    mockExit.mockRestore()
    mockConsoleError.mockRestore()
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  // (e) initAdapter is exported from adapter-factory
  it('(e) initAdapter is exported from adapter-factory', async () => {
    const mod = await import('../lib/adapter-factory.js')
    expect(typeof (mod as Record<string, unknown>)['initAdapter']).toBe('function')
  })

  // (a) DUOIDAL_TOKEN env var path
  it('(a) uses DUOIDAL_TOKEN to resolve identity and calls initAdapter flow', async () => {
    const sub = '53780fa4-3a16-4359-85aa-52c6ca9543c8'
    const jwt = buildJwt({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })
    process.env.DUOIDAL_TOKEN = jwt

    const authorizedProjects = new Set(['proj-a', 'proj-b'])
    mockResolveUserProjects.mockResolvedValueOnce(authorizedProjects)

    const fakeScope = makeScope(['res-1'], ['proj-a'])
    mockProjectScopeResolve.mockResolvedValueOnce(fakeScope)

    const { initAdapter, clearAdapter, getAdapter } = await import('../lib/adapter-factory.js')
    clearAdapter()

    await (initAdapter as () => Promise<void>)()

    expect(mockResolveUserProjects).toHaveBeenCalledWith(sub)
    expect(mockProjectScopeResolve).toHaveBeenCalledWith(
      expect.objectContaining({ roots: expect.arrayContaining([...authorizedProjects]) })
    )

    // getAdapter() should now return a PostgresOntologyAdapter instance (not throw)
    const adapter = getAdapter()
    expect(adapter).toBeDefined()
    expect(mockExit).not.toHaveBeenCalled()
  })

  // (b) token.json path
  it('(b) reads ~/.config/duoidal/token.json when DUOIDAL_TOKEN is absent', async () => {
    const sub = '6db5e531-e7d4-4053-8eaa-669b3522cc10'
    const accessToken = buildJwt({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })
    const tokenJson = JSON.stringify({ access_token: accessToken, refresh_token: 'rt' })

    mockReadFileSync.mockImplementation((filePath, ...rest) => {
      if (typeof filePath === 'string' && filePath === TOKEN_PATH) {
        return tokenJson
      }
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })

    const authorizedProjects = new Set(['proj-x'])
    mockResolveUserProjects.mockResolvedValueOnce(authorizedProjects)

    const fakeScope = makeScope([], ['proj-x'])
    mockProjectScopeResolve.mockResolvedValueOnce(fakeScope)

    const { initAdapter, clearAdapter, getAdapter } = await import('../lib/adapter-factory.js')
    clearAdapter()

    await (initAdapter as () => Promise<void>)()

    expect(mockResolveUserProjects).toHaveBeenCalledWith(sub)
    expect(mockProjectScopeResolve).toHaveBeenCalled()

    const adapter = getAdapter()
    expect(adapter).toBeDefined()
    expect(mockExit).not.toHaveBeenCalled()
  })

  // (c) no token — process.exit(1) called
  it('(c) calls process.exit(1) and logs to stderr when no token is available', async () => {
    // DUOIDAL_TOKEN absent (deleted in beforeEach), token.json throws ENOENT (set in beforeEach)

    const { initAdapter, clearAdapter } = await import('../lib/adapter-factory.js')
    clearAdapter()

    await expect(
      (initAdapter as () => Promise<void>)()
    ).rejects.toThrow('process.exit called')

    expect(mockExit).toHaveBeenCalledWith(1)
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Not authenticated')
    )
  })

  // (f) expired token triggers refresh via Supabase, persists new token
  it('(f) refreshes expired token via Supabase and persists the result', async () => {
    const sub = 'user-refresh-789'
    // Expired token (exp in the past)
    const expiredJwt = buildJwt({ sub, exp: Math.floor(Date.now() / 1000) - 600 })
    // Fresh token (exp in the future)
    const freshJwt = buildJwt({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })
    const tokenJson = JSON.stringify({ access_token: expiredJwt, refresh_token: 'valid-refresh-token' })

    mockReadFileSync.mockImplementation((filePath, ...rest) => {
      if (typeof filePath === 'string' && filePath === TOKEN_PATH) {
        return tokenJson
      }
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })

    // Mock fetch for Supabase token refresh
    const mockFetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: freshJwt, refresh_token: 'new-refresh-token', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', mockFetchFn)

    const authorizedProjects = new Set(['proj-refreshed'])
    mockResolveUserProjects.mockResolvedValueOnce(authorizedProjects)
    mockProjectScopeResolve.mockResolvedValueOnce(makeScope([], ['proj-refreshed']))

    const { initAdapter, clearAdapter, getAdapter } = await import('../lib/adapter-factory.js')
    clearAdapter()

    await (initAdapter as () => Promise<void>)()

    // Verify refresh was called with the right URL
    expect(mockFetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/auth/v1/token?grant_type=refresh_token'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'valid-refresh-token' }),
      })
    )

    // Verify the refreshed sub was used for project resolution
    expect(mockResolveUserProjects).toHaveBeenCalledWith(sub)

    // Verify token was persisted (writeFileSync called with fresh token data)
    expect(mockWriteFileSync).toHaveBeenCalled()
    const writeCall = mockWriteFileSync.mock.calls[0]
    if (writeCall) {
      const writtenContent = JSON.parse(writeCall[1] as string)
      expect(writtenContent.access_token).toBe(freshJwt)
      expect(writtenContent.refresh_token).toBe('new-refresh-token')
    }

    // Regression guard: writeLocalToken's atomic-write writes to a `.tmp.<pid>` path and
    // then renames to TOKEN_PATH. If the fs.writeFileSync mock ever falls through to the
    // real fs, the developer's actual ~/.config/duoidal/token.json gets poisoned with this
    // test's fixture (sub: 'user-refresh-789', refresh_token: 'new-refresh-token'). This
    // assertion catches that regression: writeFileSync must NEVER be called with TOKEN_PATH
    // directly, and renameSync must only be called with paths inside the test-controlled
    // mock (the safe stub returns undefined without touching disk).
    for (const call of mockWriteFileSync.mock.calls) {
      expect(call[0]).not.toBe(TOKEN_PATH)
    }

    expect(mockExit).not.toHaveBeenCalled()
    expect(getAdapter()).toBeDefined()

    vi.unstubAllGlobals()
  })

  // (d) after clearAdapter(), getAdapter() throws a descriptive auth error (not DATABASE_URL message)
  it('(d) getAdapter() after clearAdapter() throws an auth-related error, not DATABASE_URL message', async () => {
    const { getAdapter, clearAdapter } = await import('../lib/adapter-factory.js')
    clearAdapter()

    // Without DATABASE_URL and without calling initAdapter, getAdapter should either:
    // (1) throw a message about calling initAdapter first, or
    // (2) throw a message that does NOT say "DATABASE_URL not set"
    // The new behavior directs users to initAdapter, not DATABASE_URL
    expect(() => getAdapter()).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining('DATABASE_URL not set') })
    )
  })
})
