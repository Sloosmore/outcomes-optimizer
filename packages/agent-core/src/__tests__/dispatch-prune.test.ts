import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock child_process BEFORE importing the module under test so the prune's
// spawnSync calls hit our mock instead of the real tmux/ssh binaries.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  }
})

// Mock the SQL client — any DELETE the prune issues should land in a stub.
const sqlFn = vi.fn()
// Build a tagged-template fn that captures the arguments. The prune invokes
// `sql\`DELETE FROM processes WHERE ...\`` so we record the raw strings.
interface SqlMock {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  array: (arr: unknown[]) => { __arr: unknown[] }
}
const mockSql = Object.assign(
  vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    sqlFn(_strings, ..._values)
    return Promise.resolve([])
  }),
  { array: (arr: unknown[]) => ({ __arr: arr }) },
) as unknown as SqlMock

vi.mock('@skill-networks/database/client', () => ({
  getSqlClient: () => mockSql,
}))

// Mock the adapter factory — prune calls getUnscopedAdapter().getProcessByName.
const mockAdapter = {
  getProcessByName: vi.fn(),
}
vi.mock('../lib/adapter-factory.js', () => ({
  getUnscopedAdapter: () => mockAdapter,
}))

import { pruneStaleDispatchArtifacts } from '../lib/dispatch-prune.js'
import * as childProcess from 'node:child_process'
import type { DispatchConfig } from '../lib/dispatch-config.js'

const CONFIG_SELF: DispatchConfig = { server: 'self' }
const MOCK_SKILL_ID = '11111111-2222-3333-4444-555555555555'
const MOCK_SLUG = MOCK_SKILL_ID.slice(0, 8)

beforeEach(() => {
  sqlFn.mockReset()
  mockAdapter.getProcessByName.mockReset()
  vi.mocked(childProcess.spawnSync).mockReset()
  // Default: every spawnSync returns non-zero (no active session, git ops "fail").
  // Individual tests override as needed.
  vi.mocked(childProcess.spawnSync).mockImplementation(() =>
    ({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as unknown as ReturnType<typeof childProcess.spawnSync>),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Safety check — active tmux session aborts
// ---------------------------------------------------------------------------

describe('pruneStaleDispatchArtifacts — safety check', () => {
  it('throws when local tmux has-session returns 0 (session exists)', async () => {
    vi.mocked(childProcess.spawnSync).mockImplementationOnce((_bin, args) => {
      // First call is the tmux has-session probe — simulate "session exists"
      expect(Array.isArray(args)).toBe(true)
      const argv = args as string[]
      expect(argv[0]).toBe('has-session')
      expect(argv[2]).toBe(`dispatch-${MOCK_SLUG}`)
      return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as unknown as ReturnType<typeof childProcess.spawnSync>
    })

    await expect(
      pruneStaleDispatchArtifacts({
        slug: MOCK_SLUG,
        worktreeRepo: '/tmp/repo',
        dispatchBaseDir: '/tmp/dispatch',
        skillResourceId: MOCK_SKILL_ID,
        config: CONFIG_SELF,
      }),
    ).rejects.toThrow(/active tmux session.*dispatch-/)

    // Prune must NOT have touched the DB
    expect(mockAdapter.getProcessByName).not.toHaveBeenCalled()
    expect(sqlFn).not.toHaveBeenCalled()
  })

  it('proceeds when local tmux has-session returns 1 (no session)', async () => {
    // All spawnSync calls (probe + git ops) return non-zero by default — fine,
    // the probe returning 1 is the "no session" case, git ops returning non-zero
    // are just no-ops.
    mockAdapter.getProcessByName.mockResolvedValue(null)

    await expect(
      pruneStaleDispatchArtifacts({
        slug: MOCK_SLUG,
        worktreeRepo: '/tmp/repo',
        dispatchBaseDir: '/tmp/dispatch',
        skillResourceId: MOCK_SKILL_ID,
        config: CONFIG_SELF,
      }),
    ).resolves.toBeUndefined()

    // Probe fired, DB row lookup fired
    expect(mockAdapter.getProcessByName).toHaveBeenCalledWith(MOCK_SLUG)
  })

  it('--force skips the safety check even when tmux has-session returns 0', async () => {
    // Even if the probe WOULD say "session exists", force skips the probe entirely.
    vi.mocked(childProcess.spawnSync).mockImplementation(() =>
      ({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as unknown as ReturnType<typeof childProcess.spawnSync>),
    )
    mockAdapter.getProcessByName.mockResolvedValue(null)

    await expect(
      pruneStaleDispatchArtifacts(
        {
          slug: MOCK_SLUG,
          worktreeRepo: '/tmp/repo',
          dispatchBaseDir: '/tmp/dispatch',
          skillResourceId: MOCK_SKILL_ID,
          config: CONFIG_SELF,
        },
        { force: true },
      ),
    ).resolves.toBeUndefined()

    // No spawnSync call should have been `tmux has-session` — the probe is skipped.
    const probeCalls = vi.mocked(childProcess.spawnSync).mock.calls.filter(c => {
      const argv = c[1] as string[] | undefined
      return argv && argv.includes('has-session')
    })
    expect(probeCalls.length).toBe(0)
    // Prune still runs
    expect(mockAdapter.getProcessByName).toHaveBeenCalledWith(MOCK_SLUG)
  })
})

// ---------------------------------------------------------------------------
// 2. Process row cleanup — only deletes stale statuses
// ---------------------------------------------------------------------------

describe('pruneStaleDispatchArtifacts — process row cleanup', () => {
  it('deletes when process status is failed', async () => {
    mockAdapter.getProcessByName.mockResolvedValue({
      id: 'proc-uuid-1',
      name: MOCK_SLUG,
      status: 'failed',
      skill_resource_id: MOCK_SKILL_ID,
    })

    await pruneStaleDispatchArtifacts({
      slug: MOCK_SLUG,
      worktreeRepo: '/tmp/repo',
      dispatchBaseDir: '/tmp/dispatch',
      skillResourceId: MOCK_SKILL_ID,
      config: CONFIG_SELF,
    })

    expect(sqlFn).toHaveBeenCalledOnce()
    // The tagged-template's raw strings should contain DELETE FROM processes
    const raw = (sqlFn.mock.calls[0][0] as TemplateStringsArray).join(' ')
    expect(raw).toMatch(/DELETE FROM processes/)
    expect(raw).toMatch(/status = ANY/)
  })

  it('deletes when process status is completed', async () => {
    mockAdapter.getProcessByName.mockResolvedValue({
      id: 'proc-uuid-2',
      name: MOCK_SLUG,
      status: 'completed',
      skill_resource_id: MOCK_SKILL_ID,
    })

    await pruneStaleDispatchArtifacts({
      slug: MOCK_SLUG,
      worktreeRepo: '/tmp/repo',
      dispatchBaseDir: '/tmp/dispatch',
      skillResourceId: MOCK_SKILL_ID,
      config: CONFIG_SELF,
    })

    expect(sqlFn).toHaveBeenCalledOnce()
  })

  it('deletes when process status is pending', async () => {
    mockAdapter.getProcessByName.mockResolvedValue({
      id: 'proc-uuid-3',
      name: MOCK_SLUG,
      status: 'pending',
      skill_resource_id: MOCK_SKILL_ID,
    })

    await pruneStaleDispatchArtifacts({
      slug: MOCK_SLUG,
      worktreeRepo: '/tmp/repo',
      dispatchBaseDir: '/tmp/dispatch',
      skillResourceId: MOCK_SKILL_ID,
      config: CONFIG_SELF,
    })

    expect(sqlFn).toHaveBeenCalledOnce()
  })

  it('does NOT delete when process status is active (split-brain)', async () => {
    mockAdapter.getProcessByName.mockResolvedValue({
      id: 'proc-uuid-4',
      name: MOCK_SLUG,
      status: 'active',
      skill_resource_id: MOCK_SKILL_ID,
    })

    await pruneStaleDispatchArtifacts({
      slug: MOCK_SLUG,
      worktreeRepo: '/tmp/repo',
      dispatchBaseDir: '/tmp/dispatch',
      skillResourceId: MOCK_SKILL_ID,
      config: CONFIG_SELF,
    })

    expect(sqlFn).not.toHaveBeenCalled()
  })

  it('does NOT delete when process status is running', async () => {
    mockAdapter.getProcessByName.mockResolvedValue({
      id: 'proc-uuid-5',
      name: MOCK_SLUG,
      status: 'running',
      skill_resource_id: MOCK_SKILL_ID,
    })

    await pruneStaleDispatchArtifacts({
      slug: MOCK_SLUG,
      worktreeRepo: '/tmp/repo',
      dispatchBaseDir: '/tmp/dispatch',
      skillResourceId: MOCK_SKILL_ID,
      config: CONFIG_SELF,
    })

    expect(sqlFn).not.toHaveBeenCalled()
  })

  it('does NOT delete when the process belongs to a different skill_resource_id', async () => {
    mockAdapter.getProcessByName.mockResolvedValue({
      id: 'proc-uuid-6',
      name: MOCK_SLUG,
      status: 'failed',
      skill_resource_id: '99999999-9999-9999-9999-999999999999',
    })

    await pruneStaleDispatchArtifacts({
      slug: MOCK_SLUG,
      worktreeRepo: '/tmp/repo',
      dispatchBaseDir: '/tmp/dispatch',
      skillResourceId: MOCK_SKILL_ID,
      config: CONFIG_SELF,
    })

    expect(sqlFn).not.toHaveBeenCalled()
  })

  it('is a no-op when no process row exists for the slug', async () => {
    mockAdapter.getProcessByName.mockResolvedValue(null)

    await pruneStaleDispatchArtifacts({
      slug: MOCK_SLUG,
      worktreeRepo: '/tmp/repo',
      dispatchBaseDir: '/tmp/dispatch',
      skillResourceId: MOCK_SKILL_ID,
      config: CONFIG_SELF,
    })

    expect(sqlFn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. Prune failures are non-fatal
// ---------------------------------------------------------------------------

describe('pruneStaleDispatchArtifacts — failure modes', () => {
  it('does not throw when the DB lookup throws (process row cleanup is best-effort)', async () => {
    mockAdapter.getProcessByName.mockRejectedValue(new Error('DB unreachable'))

    await expect(
      pruneStaleDispatchArtifacts({
        slug: MOCK_SLUG,
        worktreeRepo: '/tmp/repo',
        dispatchBaseDir: '/tmp/dispatch',
        skillResourceId: MOCK_SKILL_ID,
        config: CONFIG_SELF,
      }),
    ).resolves.toBeUndefined()
  })

  it('does not throw when git spawn returns non-zero (worktree already gone)', async () => {
    // All spawnSync returns non-zero — probe says "no session" (good), git returns
    // non-zero (normal "nothing to remove" case).
    mockAdapter.getProcessByName.mockResolvedValue(null)

    await expect(
      pruneStaleDispatchArtifacts({
        slug: MOCK_SLUG,
        worktreeRepo: '/tmp/repo',
        dispatchBaseDir: '/tmp/dispatch',
        skillResourceId: MOCK_SKILL_ID,
        config: CONFIG_SELF,
      }),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Remote (non-self) safety check
// ---------------------------------------------------------------------------

describe('pruneStaleDispatchArtifacts — remote safety check', () => {
  const REMOTE_CONFIG: DispatchConfig = {
    server: 'openclaw',
    servers: {
      openclaw: {
        host: 'example.com',
        user: 'root',
        key: '/path/to/key',
        container: 'runtime-runtime-1',
      },
    },
  }

  it('uses ssh + docker exec to probe remote tmux', async () => {
    vi.mocked(childProcess.spawnSync).mockImplementationOnce((bin, args) => {
      expect(bin).toBe('ssh')
      const argv = args as string[]
      // The remote command (last arg) should be docker exec ... tmux has-session
      const remoteCmd = argv[argv.length - 1]
      expect(remoteCmd).toContain('docker exec runtime-runtime-1')
      expect(remoteCmd).toContain(`tmux has-session -t dispatch-${MOCK_SLUG}`)
      // Session exists → should abort
      return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as unknown as ReturnType<typeof childProcess.spawnSync>
    })

    await expect(
      pruneStaleDispatchArtifacts({
        slug: MOCK_SLUG,
        worktreeRepo: '/tmp/repo',
        dispatchBaseDir: '/tmp/dispatch',
        skillResourceId: MOCK_SKILL_ID,
        config: REMOTE_CONFIG,
      }),
    ).rejects.toThrow(/active tmux session.*dispatch-/)
  })
})
