import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Top-level mock — hoisted before imports, so no variable references allowed in factory
vi.mock('../lib/adapter-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/adapter-factory.js')>()
  return {
    ...actual,
    getAdapter: vi.fn(),
  }
})

// Mock node:child_process so tmux doesn't actually launch
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
  }
})

// Mock identity so we can control sub resolution
vi.mock('../lib/identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/identity.js')>()
  return {
    ...actual,
    getLocalSub: vi.fn(),
    getLocalSubUnchecked: vi.fn(),
    readLocalToken: vi.fn(),
    parseJwtSub: vi.fn(),
    parseJwtSubUnchecked: vi.fn(),
  }
})

// Mock new lib modules
vi.mock('../lib/goal-upload.js', () => ({
  goalUpload: vi.fn(),
}))

vi.mock('../lib/goal-link.js', () => ({
  goalLink: vi.fn(),
}))

vi.mock('../lib/project-resolve.js', () => ({
  projectResolve: vi.fn(),
}))

vi.mock('../lib/dispatch-config.js', () => ({
  readDispatchConfig: vi.fn(),
}))

vi.mock('../lib/waypoint-router.js', () => ({
  routeToServer: vi.fn(),
}))

// The existing tests do not exercise the stale-dispatch prune. Mock it out so
// its calls to getUnscopedAdapter() / getSqlClient() and the default
// spawnSync-returns-0 mock above never trigger a false-positive
// "active tmux session" abort. Dedicated tests below re-mock this module to
// exercise the prune logic directly.
vi.mock('../lib/dispatch-prune.js', () => ({
  pruneStaleDispatchArtifacts: vi.fn().mockResolvedValue(undefined),
}))

import { executeCommand } from '../commands/execute.js'
import * as adapterFactory from '../lib/adapter-factory.js'
import * as identity from '../lib/identity.js'
import * as childProcess from 'node:child_process'
import * as goalUploadMod from '../lib/goal-upload.js'
import * as goalLinkMod from '../lib/goal-link.js'
import * as projectResolveMod from '../lib/project-resolve.js'
import * as dispatchConfigMod from '../lib/dispatch-config.js'
import * as waypointRouterMod from '../lib/waypoint-router.js'
import * as dispatchPruneMod from '../lib/dispatch-prune.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-execute-test-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

function goalFile(content = 'Build a feature\n') {
  const p = path.join(tmpDir, 'goal.md')
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

const MOCK_RESOURCE_ID = '11111111-2222-3333-4444-555555555555'
const MOCK_PROJECT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function makeMockAdapter() {
  return {
    listProjectsForUser: vi.fn().mockResolvedValue([
      { id: MOCK_PROJECT_ID, name: 'Test Project', created_at: '2026-01-01' },
    ]),
    addResource: vi.fn().mockResolvedValue({
      id: MOCK_RESOURCE_ID,
      name: 'skill/test',
      type: 'skill',
    }),
    createResourceLinkById: vi.fn().mockResolvedValue({ link: {}, created: true }),
    createResourceLink: vi.fn().mockResolvedValue({ link: {}, created: true }),
    getResourceById: vi.fn().mockResolvedValue({ id: MOCK_RESOURCE_ID, name: 'skill/test' }),
  }
}

function setupDefaultMocks(mockAdapter = makeMockAdapter()) {
  vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
  vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'test-slug' })
  vi.mocked(goalLinkMod.goalLink).mockResolvedValue(undefined)
  vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(MOCK_PROJECT_ID)
  vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
  vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
  return mockAdapter
}

async function runCommand(args: string[]) {
  const cmd = executeCommand()
  cmd.exitOverride()
  return cmd.parseAsync(['node', 'agent-core', ...args])
}

// ---------------------------------------------------------------------------
// 1. --dry-run with mocked adapter
// ---------------------------------------------------------------------------

describe('execute --dry-run', () => {
  it('prints DRY RUN, Slug:, and Project ID: without calling addResource', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'build-a-test-feature' })
    vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(MOCK_PROJECT_ID)
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('Build a test feature')

    await runCommand(['--goal', goal, '--dry-run', '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    const allLogs = consoleSpy.mock.calls.map(c => String(c[0]))
    const dryRunLog = allLogs.find(l => l.includes('DRY RUN'))
    const slugLog = allLogs.find(l => l.includes('Slug:'))
    const projectIdLog = allLogs.find(l => l.includes('Project ID:'))

    expect(dryRunLog).toBeDefined()
    expect(slugLog).toBeDefined()
    expect(projectIdLog).toBeDefined()

    // In dry-run mode, goalUpload should NOT be called
    expect(goalUploadMod.goalUpload).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2. Missing goal file
// ---------------------------------------------------------------------------

describe('execute missing goal file', () => {
  it('exits with error when goal file does not exist', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(MOCK_PROJECT_ID)

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stdoutLines: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutLines.push(String(chunk))
      return true
    })

    await runCommand(['--goal', '/nonexistent/path/goal.md', '--dry-run', '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    const errorLog = stdoutLines.find(l => l.includes('[ERROR]') && l.toLowerCase().includes('could not read'))
    expect(errorLog).toBeDefined()
    expect(process.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. --sub flag bypasses local token
// ---------------------------------------------------------------------------

describe('execute --sub flag', () => {
  it('uses the sub value from --sub flag instead of calling getLocalSubUnchecked', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'feature-for-sub-test' })
    vi.mocked(goalLinkMod.goalLink).mockResolvedValue(undefined)
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })

    // getLocalSubUnchecked should NOT be called when --sub is provided
    vi.mocked(identity.getLocalSubUnchecked).mockReturnValue(null)

    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('Feature for sub test')

    // If --sub bypasses local token correctly, this should succeed
    await runCommand(['--goal', goal, '--dry-run', '--sub', 'explicit-sub-uuid', '--unlinked'])

    expect(identity.getLocalSubUnchecked).not.toHaveBeenCalled()
    // listProjectsForUser should have been called with the explicit sub
    expect(mockAdapter.listProjectsForUser).toHaveBeenCalledWith('explicit-sub-uuid')
  })

  it('falls back to getLocalSubUnchecked when --sub is not provided', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'feature-using-local-sub' })
    vi.mocked(goalLinkMod.goalLink).mockResolvedValue(undefined)
    vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(MOCK_PROJECT_ID)
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(identity.getLocalSubUnchecked).mockReturnValue('local-sub-from-token')

    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('Feature using local sub')

    await runCommand(['--goal', goal, '--dry-run', '--unlinked'])

    expect(identity.getLocalSubUnchecked).toHaveBeenCalled()
    // When --sub is not provided, projectResolve() is used (not listProjectsForUser directly)
    expect(projectResolveMod.projectResolve).toHaveBeenCalled()
  })

  it('exits with error when no sub is available', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(identity.getLocalSubUnchecked).mockReturnValue(null)

    vi.spyOn(console, 'error').mockImplementation(() => {})

    const goal = goalFile('Feature with no sub')

    await runCommand(['--goal', goal, '--dry-run', '--unlinked'])

    expect(process.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Positional [goal-path] argument
// ---------------------------------------------------------------------------

describe('execute positional goal-path', () => {
  it('accepts goal path as positional argument (same as --goal)', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'positional-goal-content' })
    vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(MOCK_PROJECT_ID)
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('Positional goal content')

    // Pass goal path as positional arg (no --goal flag)
    await runCommand([goal, '--dry-run', '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    const allLogs = consoleSpy.mock.calls.map(c => String(c[0]))
    const dryRunLog = allLogs.find(l => l.includes('DRY RUN'))
    expect(dryRunLog).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 5. --unlinked flag
// ---------------------------------------------------------------------------

describe('execute --unlinked flag', () => {
  it('works without --assign-to when --unlinked is set', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'unlinked-feature' })
    vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(MOCK_PROJECT_ID)
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })

    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('Unlinked feature')

    // --unlinked should work without --assign-to (no error)
    await expect(
      runCommand(['--goal', goal, '--dry-run', '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])
    ).resolves.not.toThrow()
  })

  it('errors when neither --assign-to nor --unlinked is provided', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'no-assignment' })
    vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(MOCK_PROJECT_ID)
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const goal = goalFile('No assignment')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe'])

    expect(process.exitCode).toBe(1)
    expect(goalUploadMod.goalUpload).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 6. Live execution path — write paths and tmux launch
// ---------------------------------------------------------------------------

describe('execute live mode', () => {
  it('uploads skill resource and launches tmux session with correct args', async () => {
    const mockAdapter = setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'live-execution-feature' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')

    const goal = goalFile('Live execution feature')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--epochs', '5', '--unlinked'])

    expect(goalUploadMod.goalUpload).toHaveBeenCalledOnce()
    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    expect(execFileSyncMock).toHaveBeenCalledOnce()
    const [bin, args] = execFileSyncMock.mock.calls[0] as [string, string[]]
    expect(bin).toBe('tmux')
    expect(args).toContain('new-session')
    expect(args).toContain('-d')
    // Session name uses the resource UUID returned by the mock
    const sessionArg = args.find(a => a.startsWith('dispatch-'))
    expect(sessionArg).toBe(`dispatch-${MOCK_RESOURCE_ID}`)
    // Shell command contains correct flags
    const shellCmd = args[args.length - 1] ?? ''
    expect(shellCmd).toContain(`--skill-resource-id ${MOCK_RESOURCE_ID}`)
    expect(shellCmd).toContain('--epochs 5')
    expect(shellCmd).toContain('--unlinked')
  })

  it('calls goalUpload and createResourceLinkById with correct args', async () => {
    const mockAdapter = setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'build-a-widget' })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('# Build a widget\nSome description')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    expect(goalUploadMod.goalUpload).toHaveBeenCalledOnce()
    expect(mockAdapter.createResourceLinkById).toHaveBeenCalledWith(MOCK_RESOURCE_ID, MOCK_PROJECT_ID, 'parent')
  })

  it('calls goalLink when --assign-to is provided', async () => {
    const mockAdapter = setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'assign-feature' })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('# Assign feature')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--assign-to', 'agent-foo'])

    expect(goalLinkMod.goalLink).toHaveBeenCalledWith(MOCK_RESOURCE_ID, 'agent-foo')
  })

  it('skips createResourceLinkById when no projects found', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.listProjectsForUser.mockResolvedValue([])
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'no-project-feature' })
    vi.mocked(goalLinkMod.goalLink).mockResolvedValue(undefined)
    vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(null)
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const goal = goalFile('# No project feature')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    expect(goalUploadMod.goalUpload).toHaveBeenCalled()
    expect(mockAdapter.createResourceLinkById).not.toHaveBeenCalled()
  })

  it('rejects invalid --epochs values', async () => {
    const mockAdapter = setupDefaultMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const goal = goalFile('Bad epochs')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--epochs', 'abc', '--unlinked'])

    expect(process.exitCode).toBe(1)
    expect(goalUploadMod.goalUpload).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 7. Frontmatter assignment extraction
// ---------------------------------------------------------------------------

describe('frontmatter assignment extraction', () => {
  it('extracts assignment from frontmatter when no --agent flag is provided', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'goal' })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('---\nassignment: agent-efficiency\n---\n# Goal\n')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe'])

    expect(goalLinkMod.goalLink).toHaveBeenCalledWith(MOCK_RESOURCE_ID, 'agent-efficiency')
  })

  it('--agent flag wins over frontmatter assignment', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'goal' })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('---\nassignment: agent-efficiency\n---\n# Goal\n')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--agent', 'prod-failures'])

    expect(goalLinkMod.goalLink).toHaveBeenCalledWith(MOCK_RESOURCE_ID, 'prod-failures')
  })

  it('falls back to config default_link when no flag or frontmatter assignment', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'goal' })
    vi.mocked(goalLinkMod.goalLink).mockResolvedValue(undefined)
    vi.mocked(projectResolveMod.projectResolve).mockResolvedValue(MOCK_PROJECT_ID)
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self', default_link: 'config-agent' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('# Goal without assignment\n')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe'])

    expect(goalLinkMod.goalLink).toHaveBeenCalledWith(MOCK_RESOURCE_ID, 'config-agent')
  })
})

// ---------------------------------------------------------------------------
// 8. --skill-resource-id path (Path A)
// ---------------------------------------------------------------------------

describe('execute --skill-resource-id path', () => {
  it('skips goalUpload and goalLink, launches tmux when server is self', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '5'])

    expect(goalUploadMod.goalUpload).not.toHaveBeenCalled()
    expect(goalLinkMod.goalLink).not.toHaveBeenCalled()
    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    expect(execFileSyncMock).toHaveBeenCalledOnce()
    const [bin, args] = execFileSyncMock.mock.calls[0] as [string, string[]]
    expect(bin).toBe('tmux')
    const sessionArg = args.find(a => a.startsWith('dispatch-'))
    expect(sessionArg).toBe(`dispatch-${MOCK_RESOURCE_ID}`)
    const shellCmd = args[args.length - 1] ?? ''
    expect(shellCmd).toContain(`--skill-resource-id ${MOCK_RESOURCE_ID}`)
    expect(shellCmd).toContain('--epochs 5')
  })

  it('skips tmux launch when server is not self (SSH handled routing)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({
      server: 'openclaw',
      servers: {
        openclaw: { host: 'openclaw.example.com', user: 'agent', key: '/root/.ssh/id_rsa' },
      },
    })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: false })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID])

    expect(goalUploadMod.goalUpload).not.toHaveBeenCalled()
    expect(goalLinkMod.goalLink).not.toHaveBeenCalled()
    expect(vi.mocked(childProcess.execFileSync)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 9. Routing behavior
// ---------------------------------------------------------------------------

describe('routing behavior', () => {
  it('launches tmux when server is self', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'test' })
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('# Test goal')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledOnce()
    // spawnSync is called once: a single tmux has-session probe at 500ms by
    // assertTmuxSessionAlive(). Mock above returns status:0 so the probe passes.
    const spawnCalls = vi.mocked(childProcess.spawnSync).mock.calls
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0][0]).toBe('tmux')
    expect(spawnCalls[0][1]).toEqual(['has-session', '-t', expect.stringMatching(/^dispatch-/)])
  })

  it('throws actionable error when inner tmux command crashes immediately', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'test' })
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    // Simulate inner crash: has-session returns non-zero (session gone)
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      status: 1, stdout: Buffer.from(''), stderr: Buffer.from(''),
      signal: null, output: [], pid: 0,
    } as ReturnType<typeof childProcess.spawnSync>)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('# Test goal')
    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    // Banner must NOT print when session died
    const launchedBanners = logSpy.mock.calls.flat().filter(c => typeof c === 'string' && c.includes('Launched tmux session'))
    expect(launchedBanners.length).toBe(0)
    // CLI must exit non-zero so the error reaches the caller
    expect(process.exitCode).toBe(1)
  })

  it('does not launch tmux locally when server is not self', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'test' })
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({
      server: 'openclaw',
      servers: {
        openclaw: { host: 'openclaw.example.com', user: 'agent', key: '/root/.ssh/id_rsa' },
      },
    })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: false })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('# Test goal')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    expect(vi.mocked(childProcess.execFileSync)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 10. --hops flag
// ---------------------------------------------------------------------------

describe('--hops flag', () => {
  it('passes hopCount to routeToServer', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'test' })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('# Test goal')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked', '--hops', '3'])

    expect(waypointRouterMod.routeToServer).toHaveBeenCalledWith(
      expect.any(Object),
      MOCK_RESOURCE_ID,
      expect.any(Number),
      expect.objectContaining({ hopCount: 3 })
    )
  })

  it('defaults hopCount to 0 when --hops not provided', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'test' })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const goal = goalFile('# Test goal')

    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    expect(waypointRouterMod.routeToServer).toHaveBeenCalledWith(
      expect.any(Object),
      MOCK_RESOURCE_ID,
      expect.any(Number),
      expect.objectContaining({ hopCount: 0 })
    )
  })
})

// ---------------------------------------------------------------------------
// 11. .env sourcing in tmux shell command
// ---------------------------------------------------------------------------

describe('.env sourcing before tmux dispatch', () => {
  it('prepends POSIX dot-source prefix when .env exists (Path B)', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'env-test' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // Write a .env file into the tmpDir so fs.existsSync returns true
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\n', 'utf-8')
    vi.stubEnv('WORKTREE_REPO', tmpDir)

    const goal = goalFile('# Env source test')
    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    expect(execFileSyncMock).toHaveBeenCalledOnce()
    const shellCmd = (execFileSyncMock.mock.calls[0] as [string, string[]])[1].at(-1) ?? ''
    expect(shellCmd).toContain(`set -a && . ${tmpDir}/.env && set +a`)
  })

  it('omits source prefix when .env does not exist (Path B)', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'no-env-test' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('WORKTREE_REPO', tmpDir)

    const goal = goalFile('# No env source test')
    await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    expect(execFileSyncMock).toHaveBeenCalledOnce()
    const shellCmd = (execFileSyncMock.mock.calls[0] as [string, string[]])[1].at(-1) ?? ''
    expect(shellCmd).not.toContain('set -a')
    expect(shellCmd).toContain('node ')
  })

  it('prepends POSIX dot-source prefix when .env exists (Path A — --skill-resource-id)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    fs.writeFileSync(path.join(tmpDir, '.env'), 'BAR=baz\n', 'utf-8')
    vi.stubEnv('WORKTREE_REPO', tmpDir)

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '3'])

    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    expect(execFileSyncMock).toHaveBeenCalledOnce()
    const shellCmd = (execFileSyncMock.mock.calls[0] as [string, string[]])[1].at(-1) ?? ''
    expect(shellCmd).toContain(`set -a && . ${tmpDir}/.env && set +a`)
  })
})

// ---------------------------------------------------------------------------
// 12. WORKTREE_REPO resolution (local "self" vs cloud)
// ---------------------------------------------------------------------------

describe('WORKTREE_REPO resolution', () => {
  it('falls back to process.cwd() when server is "self" and WORKTREE_REPO is unset (Path A)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // Ensure WORKTREE_REPO is NOT set — test the fallback path
    vi.stubEnv('WORKTREE_REPO', '')
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

    try {
      await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '3'])

      const execFileSyncMock = vi.mocked(childProcess.execFileSync)
      expect(execFileSyncMock).toHaveBeenCalledOnce()
      const [, args] = execFileSyncMock.mock.calls[0] as [string, string[]]
      // tmux args contain `-c <cwd>` — verify it's the process.cwd()
      const cwdIdx = args.indexOf('-c')
      expect(cwdIdx).toBeGreaterThanOrEqual(0)
      expect(args[cwdIdx + 1]).toBe(tmpDir)
      // DISPATCH_BUNDLE path should be anchored to tmpDir, not /root/dispatch
      const shellCmd = args.at(-1) ?? ''
      expect(shellCmd).toContain(path.join(tmpDir, 'utils', 'dispatch', 'dispatch.prebuilt.mjs'))
      expect(shellCmd).not.toContain('/root/dispatch')
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('falls back to process.cwd() when server is "self" and WORKTREE_REPO is unset (Path B — goal file)', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'local-dev' })
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // Ensure WORKTREE_REPO is NOT set — test the fallback path
    vi.stubEnv('WORKTREE_REPO', '')
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

    try {
      const goal = goalFile('# Local dev goal')
      await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

      const execFileSyncMock = vi.mocked(childProcess.execFileSync)
      expect(execFileSyncMock).toHaveBeenCalledOnce()
      const [, args] = execFileSyncMock.mock.calls[0] as [string, string[]]
      const cwdIdx = args.indexOf('-c')
      expect(cwdIdx).toBeGreaterThanOrEqual(0)
      expect(args[cwdIdx + 1]).toBe(tmpDir)
      const shellCmd = args.at(-1) ?? ''
      expect(shellCmd).not.toContain('/root/dispatch')
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('honors WORKTREE_REPO env var when explicitly set (Path A)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('WORKTREE_REPO', '/root/explicit-override')

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '3'])

    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    expect(execFileSyncMock).toHaveBeenCalledOnce()
    const [, args] = execFileSyncMock.mock.calls[0] as [string, string[]]
    const cwdIdx = args.indexOf('-c')
    expect(args[cwdIdx + 1]).toBe('/root/explicit-override')
  })

  it('exports WORKTREE_REPO into the tmux shell command so dispatch.ts inherits it (Path A)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('WORKTREE_REPO', '')
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

    try {
      await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '3'])

      const execFileSyncMock = vi.mocked(childProcess.execFileSync)
      expect(execFileSyncMock).toHaveBeenCalledOnce()
      const shellCmd = (execFileSyncMock.mock.calls[0] as [string, string[]])[1].at(-1) ?? ''
      // WORKTREE_REPO must be exported in the shell command so dispatch.ts's own
      // fallback does not land on /root/repos/outcomes-optimizer on a dev laptop.
      expect(shellCmd).toContain(`WORKTREE_REPO=${tmpDir}`)
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('exports WORKTREE_REPO into the tmux shell command (Path B — goal file)', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'export-wr' })
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('WORKTREE_REPO', '')
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

    try {
      const goal = goalFile('# Export WR test')
      await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

      const execFileSyncMock = vi.mocked(childProcess.execFileSync)
      expect(execFileSyncMock).toHaveBeenCalledOnce()
      const shellCmd = (execFileSyncMock.mock.calls[0] as [string, string[]])[1].at(-1) ?? ''
      expect(shellCmd).toContain(`WORKTREE_REPO=${tmpDir}`)
    } finally {
      cwdSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 13. Stale-dispatch auto-prune wiring (Path A)
// ---------------------------------------------------------------------------

describe('auto-prune stale dispatch artifacts (Path A)', () => {
  it('calls pruneStaleDispatchArtifacts with the correct slug before routing', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.mocked(dispatchPruneMod.pruneStaleDispatchArtifacts).mockResolvedValue(undefined)
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '5'])

    const expectedSlug = MOCK_RESOURCE_ID.slice(0, 8)
    expect(dispatchPruneMod.pruneStaleDispatchArtifacts).toHaveBeenCalledOnce()
    const [target, prunOpts] = vi.mocked(dispatchPruneMod.pruneStaleDispatchArtifacts).mock.calls[0]
    expect(target.slug).toBe(expectedSlug)
    expect(target.skillResourceId).toBe(MOCK_RESOURCE_ID)
    expect(prunOpts).toEqual({ force: undefined })
    expect(waypointRouterMod.routeToServer).toHaveBeenCalled()
  })

  it('aborts dispatch when prune throws (simulating active tmux session)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.mocked(dispatchPruneMod.pruneStaleDispatchArtifacts).mockRejectedValue(
      new Error("Refusing to re-dispatch skill ...: active tmux session 'dispatch-11111111' found on local host."),
    )
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stdoutLines: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutLines.push(String(chunk))
      return true
    })

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '5'])

    expect(process.exitCode).toBe(1)
    expect(waypointRouterMod.routeToServer).not.toHaveBeenCalled()
    expect(childProcess.execFileSync).not.toHaveBeenCalled()
    const errorLog = stdoutLines.find(l => l.includes('[ERROR]') && l.toLowerCase().includes('active tmux session'))
    expect(errorLog).toBeDefined()
    // Reset exitCode so subsequent tests start clean
    process.exitCode = 0
  })

  it('--force is forwarded to the prune', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.mocked(dispatchPruneMod.pruneStaleDispatchArtifacts).mockResolvedValue(undefined)
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '5', '--force'])

    expect(dispatchPruneMod.pruneStaleDispatchArtifacts).toHaveBeenCalledOnce()
    const [, prunOpts] = vi.mocked(dispatchPruneMod.pruneStaleDispatchArtifacts).mock.calls[0]
    expect(prunOpts).toEqual({ force: true })
  })
})

// ---------------------------------------------------------------------------
// 14. DISPATCH_BASE_DIR resolution (local "self" vs cloud)
// ---------------------------------------------------------------------------

describe('DISPATCH_BASE_DIR resolution', () => {
  // The SUT calls fs.mkdirSync(DISPATCH_BASE_DIR, { recursive: true }) just before the
  // tmux launch. The resolved paths in these tests point at locations the test runner
  // cannot actually create (/custom/dispatch, /home/testuser/...), so without this
  // stub the real mkdir throws EACCES, the outer try/catch bails out, and the tmux
  // execFileSync assertion fails with "called 0 times".
  let mkdirSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
  })
  afterEach(() => {
    mkdirSpy.mockRestore()
  })

  it('honors DISPATCH_BASE_DIR env var when explicitly set (Path A)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    vi.stubEnv('DISPATCH_BASE_DIR', '/custom/dispatch')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '3'])

    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    expect(execFileSyncMock).toHaveBeenCalledOnce()
    const shellCmd = (execFileSyncMock.mock.calls[0] as [string, string[]])[1].at(-1) ?? ''
    expect(shellCmd).toContain('DISPATCH_BASE_DIR=/custom/dispatch')
  })

  it('falls back to ~/.duoidal/dispatch when server is "self" and DISPATCH_BASE_DIR is unset (Path A)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    vi.stubEnv('DISPATCH_BASE_DIR', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser')

    try {
      await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '3'])

      const execFileSyncMock = vi.mocked(childProcess.execFileSync)
      expect(execFileSyncMock).toHaveBeenCalledOnce()
      const shellCmd = (execFileSyncMock.mock.calls[0] as [string, string[]])[1].at(-1) ?? ''
      expect(shellCmd).toContain('DISPATCH_BASE_DIR=/home/testuser/.duoidal/dispatch')
    } finally {
      homedirSpy.mockRestore()
    }
  })

  it('uses /root/dispatch when server is not "self" and DISPATCH_BASE_DIR is unset (Path A)', async () => {
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({
      server: 'openclaw',
      servers: {
        openclaw: { host: 'openclaw.example.com', user: 'agent', key: '/root/.ssh/id_rsa' },
      },
    })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: false })
    vi.stubEnv('DISPATCH_BASE_DIR', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['--skill-resource-id', MOCK_RESOURCE_ID, '--epochs', '3'])

    // No tmux launch for non-self server — verify routeToServer was reached (path check passed)
    expect(waypointRouterMod.routeToServer).toHaveBeenCalled()
    expect(vi.mocked(childProcess.execFileSync)).not.toHaveBeenCalled()
  })

  it('exports DISPATCH_BASE_DIR into the tmux shell command (Path B — goal file)', async () => {
    setupDefaultMocks()
    vi.mocked(goalUploadMod.goalUpload).mockResolvedValue({ skillResourceId: MOCK_RESOURCE_ID, slug: 'dispatch-base-dir-test' })
    vi.mocked(dispatchConfigMod.readDispatchConfig).mockReturnValue({ server: 'self' })
    vi.mocked(waypointRouterMod.routeToServer).mockReturnValue({ local: true })
    vi.stubEnv('WORKTREE_REPO', '/root/safe-worktree')
    vi.stubEnv('DISPATCH_BASE_DIR', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser')

    try {
      const goal = goalFile('# Dispatch base dir export test')
      await runCommand(['--goal', goal, '--sub', '3ad861e6-ac17-41fb-8dbf-4ffa2f739afe', '--unlinked'])

      const execFileSyncMock = vi.mocked(childProcess.execFileSync)
      expect(execFileSyncMock).toHaveBeenCalledOnce()
      const shellCmd = (execFileSyncMock.mock.calls[0] as [string, string[]])[1].at(-1) ?? ''
      expect(shellCmd).toContain('DISPATCH_BASE_DIR=/home/testuser/.duoidal/dispatch')
    } finally {
      homedirSpy.mockRestore()
    }
  })
})
