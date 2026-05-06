/**
 * Unit tests for the worktree provisioner's skill-fetch adapter.
 *
 * Tests the logic that runs when --skill-resource-id is passed to provision():
 *   - calls fetch() POST /rest/v1/rpc/fetch_skill_content
 *   - parses the JSON response
 *   - writes workspace/goal.md
 *   - sets ctx.skillResourceId
 *
 * All subprocess calls are mocked via vi.mock('child_process'). The rest of
 * the provisioner (git worktree, npm ci, builds) also runs through the mock,
 * which returns successful no-ops so that only the goal-fetch path is exercised
 * by the assertions.
 *
 * Setup uses in-place mode (--worktree === --repo) pointing at a real tmpdir,
 * with the required package.json stubs to satisfy sourceHash(). The execFileSync
 * mock short-circuits all build subprocess calls, so no actual compilation runs.
 *
 * RPC calls (init_process, fetch_skill_content) use fetch() mocked via vi.stubGlobal.
 */

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

// Must be called before importing the module under test so vitest hoists the mock.
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('@skill-networks/agent-events', () => ({
  createEventService: vi.fn(() => null),
  createWatchdog: vi.fn(() => ({ stop: vi.fn() })),
  EventType: {
    PROCESS_START: 'process:start',
    PROCESS_END: 'process:end',
    PROCESS_SLEEP: 'process:sleep',
    PROCESS_STALE: 'process:stale',
    EPOCH_END: 'epoch:end',
    WORKTREE_PROVISIONED: 'worktree:provisioned',
  },
}))

import { execFileSync } from 'child_process'
import { provision, teardown } from '../provisioners/worktree.js'
import { ProvisionContext } from '../provision-context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GOAL_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const MOCK_PROCESS_ID = 'deadbeef-1234-5678-abcd-ef0123456789'

/** Minimal in-place worktree pointing at a real tmpdir. */
function makeWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'))
  return dir
}

// ---------------------------------------------------------------------------
// Before / after
// ---------------------------------------------------------------------------

let tmpDir: string
let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  tmpDir = makeWorktree()
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
  process.env['SUPABASE_URL'] = 'https://test.supabase.co'
  process.env['SUPABASE_SERVICE_KEY'] = 'test-key'
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  delete process.env['SUPABASE_URL']
  delete process.env['SUPABASE_SERVICE_KEY']
})

// ---------------------------------------------------------------------------
// In-place opts helper
// ---------------------------------------------------------------------------

function inPlaceOpts(extra: Record<string, string> = {}): Record<string, string> {
  return {
    repo: tmpDir,
    worktree: tmpDir,
    'base-dir': os.tmpdir(),
    ...extra,
  }
}

/** Sets up fetch mock to handle both RPC calls.
 *  - init_process → returns { process_id: MOCK_PROCESS_ID }
 *  - fetch_skill_content → returns skillJson (or throws if it's an Error)
 */
function setupFetchMock(skillContent: string | null | Error = null): void {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/rpc/init_process')) {
      return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
    }
    if (url.includes('/rpc/fetch_skill_content')) {
      if (skillContent instanceof Error) throw skillContent
      const data = skillContent !== null ? { content: skillContent } : null
      return { ok: true, status: 200, json: async () => data, text: async () => '' }
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worktree provisioner — skill-fetch adapter', () => {
  it('writes workspace/goal.md when --skill-resource-id is provided', async () => {
    setupFetchMock('# My Goal\n\nDo the thing.')

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))

    const goalPath = path.join(tmpDir, 'workspace', 'goal.md')
    expect(fs.existsSync(goalPath)).toBe(true)
    expect(fs.readFileSync(goalPath, 'utf-8')).toBe('# My Goal\n\nDo the thing.')
  })

  it('sets ctx.skillResourceId when --skill-resource-id is provided', async () => {
    setupFetchMock('# Goal')

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))

    expect(ctx.skillResourceId).toBe(GOAL_UUID)
  })

  it('does NOT write workspace/goal.md when --skill-resource-id is absent', async () => {
    // Only init_process will be called (from in-place existing worktree, it won't be called either)
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts())

    expect(fs.existsSync(path.join(tmpDir, 'workspace', 'goal.md'))).toBe(false)
    expect(ctx.skillResourceId).toBeUndefined()
  })

  it('creates workspace/ directory if it does not exist', async () => {
    setupFetchMock('# Goal')

    // Confirm workspace/ does not exist before provision
    expect(fs.existsSync(path.join(tmpDir, 'workspace'))).toBe(false)

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))

    expect(fs.existsSync(path.join(tmpDir, 'workspace'))).toBe(true)
  })

  it('throws when fetch_skill_content throws a network error', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      if (url.includes('/rpc/fetch_skill_content')) {
        throw new Error('fetch_skill_content network error')
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const ctx = new ProvisionContext()
    await expect(
      provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))
    ).rejects.toThrow(`[worktree] Failed to fetch skill content for ${GOAL_UUID}`)
  })

  it('throws when fetch_skill_content returns non-ok status', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      if (url.includes('/rpc/fetch_skill_content')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'Internal Server Error' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const ctx = new ProvisionContext()
    await expect(
      provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))
    ).rejects.toThrow(`[worktree] fetch_skill_content RPC returned 500`)
  })

  it('throws when --skill-resource-id is not a valid UUID', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const ctx = new ProvisionContext()
    await expect(
      provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': 'not-a-uuid' }))
    ).rejects.toThrow('[worktree] Invalid --skill-resource-id (must be a UUID)')
  })

  it('throws when config.content is an empty string', async () => {
    setupFetchMock('')

    const ctx = new ProvisionContext()
    await expect(
      provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))
    ).rejects.toThrow(`[worktree] Skill resource ${GOAL_UUID} has no config.content`)
  })

  it('throws when content is absent from JSON (null response)', async () => {
    setupFetchMock(null)

    const ctx = new ProvisionContext()
    await expect(
      provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))
    ).rejects.toThrow(`[worktree] Skill resource ${GOAL_UUID} has no config.content`)
  })

  it('skill content written is exactly what fetch_skill_content returned (no trimming or mutation)', async () => {
    const exactContent = '# Goal\n\nLine 1.\nLine 2.\n\n> blockquote\n'
    setupFetchMock(exactContent)

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))

    const written = fs.readFileSync(path.join(tmpDir, 'workspace', 'goal.md'), 'utf-8')
    expect(written).toBe(exactContent)
  })

  it('fetch was called with correct URL and body for fetch_skill_content RPC', async () => {
    setupFetchMock('# Goal')

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))

    // Find the fetch_skill_content call
    const skillCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/rpc/fetch_skill_content')
    )
    expect(skillCall).toBeDefined()
    const [url, opts] = skillCall as [string, RequestInit]
    expect(url).toBe('https://test.supabase.co/rest/v1/rpc/fetch_skill_content')
    expect(opts.method).toBe('POST')
    const bodyParsed = JSON.parse(opts.body as string)
    expect(bodyParsed).toEqual({ p_skill_resource_id: GOAL_UUID })
  })

  it('skill fetch is called when --skill-resource-id is present', async () => {
    setupFetchMock('# Goal')

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts({ 'skill-resource-id': GOAL_UUID }))

    const skillCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/rpc/fetch_skill_content')
    )
    expect(skillCall).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Process creation tests
// ---------------------------------------------------------------------------

describe('worktree provisioner — process creation', () => {
  it('fresh worktree calls init_process RPC and sets ctx.processId', async () => {
    // Mock git worktree add to scaffold the directory
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
        const addIdx = args.indexOf('add')
        const targetPath = args[addIdx + 1]
        if (targetPath && !fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true })
        }
      }
      return ''
    }) as never)

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    // Use a path that does NOT exist on disk — this makes it a "fresh" worktree.
    const freshPath = path.join(tmpDir, 'fresh-child')
    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', {
      repo: tmpDir,
      worktree: freshPath,
      'base-dir': tmpDir,
      branch: 'boot/test-slug',
    })

    expect(ctx.processId).toBe(MOCK_PROCESS_ID)

    // Verify fetch was called with init_process URL
    const initCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/rpc/init_process')
    )
    expect(initCall).toBeDefined()
    const [, opts] = initCall as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect(body).toMatchObject({
      p_name: 'test-slug',
      p_branch: 'boot/test-slug',
      p_run_type: 'local',
    })
  })

  it('existing worktree reads EVAL_PROCESS_ID from .env', async () => {
    // Write a .env file before provisioning — in-place mode treats it as existing
    fs.writeFileSync(path.join(tmpDir, '.env'), 'EVAL_PROCESS_ID="existing-uuid-here"\n')
    vi.mocked(execFileSync).mockImplementation((() => '') as never)

    // init_process should NOT be called since processId is read from .env
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        throw new Error('init_process should not be called for existing worktree')
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts())

    expect(ctx.processId).toBe('existing-uuid-here')

    // Verify process init was NOT called
    const initCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/rpc/init_process')
    )
    expect(initCall).toBeUndefined()
  })

  it('init_process RPC failure throws with [worktree] prefix', async () => {
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
        const addIdx = args.indexOf('add')
        const targetPath = args[addIdx + 1]
        if (targetPath && !fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true })
        }
      }
      return ''
    }) as never)

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        throw new Error('network error')
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const freshPath = path.join(tmpDir, 'fresh-fail')
    const ctx = new ProvisionContext()
    await expect(
      provision(ctx, 'test-slug', {
        repo: tmpDir,
        worktree: freshPath,
        'base-dir': tmpDir,
        branch: 'boot/test-slug',
      })
    ).rejects.toThrow('[worktree]')
  })

  it('default run-type is local when no run-type opt is passed', async () => {
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
        const addIdx = args.indexOf('add')
        const targetPath = args[addIdx + 1]
        if (targetPath && !fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true })
        }
      }
      return ''
    }) as never)

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const freshPath = path.join(tmpDir, 'fresh-default-rt')
    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', {
      repo: tmpDir,
      worktree: freshPath,
      'base-dir': tmpDir,
      branch: 'boot/test-slug',
    })

    const initCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/rpc/init_process')
    )
    expect(initCall).toBeDefined()
    const [, opts] = initCall as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect(body.p_run_type).toBe('local')
  })

  it('skill-resource-id is forwarded to init_process RPC body when present', async () => {
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
        const addIdx = args.indexOf('add')
        const targetPath = args[addIdx + 1]
        if (targetPath && !fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true })
        }
      }
      return ''
    }) as never)

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      if (url.includes('/rpc/fetch_skill_content')) {
        return { ok: true, status: 200, json: async () => ({ content: '# Goal' }), text: async () => '' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const freshPath = path.join(tmpDir, 'fresh-skill')
    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', {
      repo: tmpDir,
      worktree: freshPath,
      'base-dir': tmpDir,
      branch: 'boot/test-slug',
      'skill-resource-id': GOAL_UUID,
    })

    const initCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/rpc/init_process')
    )
    expect(initCall).toBeDefined()
    const [, opts] = initCall as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect(body.p_skill_resource_id).toBe(GOAL_UUID)
  })
})

// ---------------------------------------------------------------------------
// Teardown regression tests
// ---------------------------------------------------------------------------

describe('worktree provisioner — teardown', () => {
  let worktreeDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    // Create a real temp directory that represents the worktree
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-teardown-test-'))
  })

  afterEach(() => {
    // Clean up if the test did not delete the directory
    if (fs.existsSync(worktreeDir)) {
      fs.rmSync(worktreeDir, { recursive: true, force: true })
    }
  })

  it('deletes the worktree directory even when git push throws', async () => {
    // Mock execFileSync: let git add/commit/rev-parse succeed, but throw on push
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && Array.isArray(args)) {
        if (args.includes('push')) {
          throw new Error('fatal: push failed (simulated network error)')
        }
        if (args.includes('rev-parse')) {
          return 'boot/test-push-fail\n'
        }
      }
      return ''
    }) as never)

    const ctx = new ProvisionContext()
    ctx.worktreePath = worktreeDir

    await teardown(ctx, 'test-push-fail')

    // The directory must be gone regardless of push failure
    expect(fs.existsSync(worktreeDir)).toBe(false)
  })

  it('deletes the worktree directory when push succeeds', async () => {
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && Array.isArray(args) && args.includes('rev-parse')) {
        return 'boot/test-push-ok\n'
      }
      return ''
    }) as never)

    const ctx = new ProvisionContext()
    ctx.worktreePath = worktreeDir

    await teardown(ctx, 'test-push-ok')

    expect(fs.existsSync(worktreeDir)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Repo .env seeding
// ---------------------------------------------------------------------------

describe('repo .env seeding', () => {
  it('seeds worktree env from source repo .env for non-in-place worktrees', async () => {
    // Write a .env in the "repo" directory
    fs.writeFileSync(path.join(tmpDir, '.env'), [
      'ANTHROPIC_API_KEY=proxy-token-123',
      'ANTHROPIC_BASE_URL=http://127.0.0.1:8317',
      '# comment line',
      'DATABASE_URL="postgres://host/db"',
      'export EXPORTED_VAR=exported-value',
      // Reserved keys must not be seeded — they are set by ProvisionContext.writeEnv()
      // after envMap entries, so seeding them would let stale source-repo values win.
      'WORKTREE_PATH=/stale/path',
      'EVAL_PROCESS_ID=stale-id',
      '',
    ].join('\n'))

    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
        const addIdx = args.indexOf('add')
        const targetPath = args[addIdx + 1]
        if (targetPath && !fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true })
        }
      }
      return ''
    }) as never)

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const freshPath = path.join(tmpDir, 'fresh-env-seed')
    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', {
      repo: tmpDir,
      worktree: freshPath,
      'base-dir': tmpDir,
      branch: 'boot/test-slug',
    })

    // Verify seeded values are in the context
    expect(ctx.getEnv('ANTHROPIC_API_KEY')).toBe('proxy-token-123')
    expect(ctx.getEnv('ANTHROPIC_BASE_URL')).toBe('http://127.0.0.1:8317')
    expect(ctx.getEnv('DATABASE_URL')).toBe('postgres://host/db')
    expect(ctx.getEnv('EXPORTED_VAR')).toBe('exported-value')
    // Reserved keys must not be seeded — stale source-repo values must not win
    expect(ctx.getEnv('WORKTREE_PATH')).toBeUndefined()
    expect(ctx.getEnv('EVAL_PROCESS_ID')).toBeUndefined()
  })

  it('skips seeding for in-place worktrees', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'ANTHROPIC_API_KEY=should-not-be-seeded\n')

    vi.mocked(execFileSync).mockImplementation((() => '') as never)
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', inPlaceOpts())

    expect(ctx.getEnv('ANTHROPIC_API_KEY')).toBeUndefined()
  })

  it('gracefully handles missing repo .env', async () => {
    // No .env in repo — should not throw
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
        const addIdx = args.indexOf('add')
        const targetPath = args[addIdx + 1]
        if (targetPath && !fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true })
        }
      }
      return ''
    }) as never)

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rpc/init_process')) {
        return { ok: true, status: 200, json: async () => ({ process_id: MOCK_PROCESS_ID }), text: async () => '' }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const freshPath = path.join(tmpDir, 'fresh-no-env')
    const ctx = new ProvisionContext()
    await provision(ctx, 'test-slug', {
      repo: tmpDir,
      worktree: freshPath,
      'base-dir': tmpDir,
      branch: 'boot/test-slug',
    })

    expect(ctx.getEnv('ANTHROPIC_API_KEY')).toBeUndefined()
    expect(ctx.worktreePath).toBe(freshPath)
  })
})
