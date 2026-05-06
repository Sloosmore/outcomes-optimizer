/**
 * Integration tests for the worktree provisioner's process ID flow.
 *
 * These tests exercise the real `agent-core process init` CLI to create actual
 * DB rows, verifying end-to-end that:
 *   1. Fresh provision creates a DB row with status "pending" and writes EVAL_PROCESS_ID
 *      to both provision-output.env and <worktreePath>/.env.
 *   2. Re-provision is a no-op: reads EVAL_PROCESS_ID from the existing .env and does
 *      NOT call agent-core process init a second time.
 *   3. DB unreachable: provision() rejects with an error.
 *   4. launch() throws loudly when processId is undefined.
 *
 * Git/pnpm/build subprocess calls are mocked to avoid slow I/O; the agent-core
 * process init call is let through to the real CLI.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { ProvisionContext } from '../provision-context.js'
import { launch } from '../steps/launch.js'



// Must be hoisted before module import so vitest processes vi.mock() calls first.
// Only execFileSync is replaced with a vi.fn(). spawnSync remains unaffected.
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

const mockedExecFileSync = vi.mocked(execFileSync)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Calls the real CLI by bypassing the vi.mock() shim.
 * vi.mock() intercepts ESM-imported execFileSync but not Node's built-in
 * child_process accessed via require(). spawnSync is synchronous, throws on
 * nonzero exit, and returns stdout as a string.
 */
function callRealCli(cmd: string, args: string[], opts?: { cwd?: string }): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process')
  // Some test files in packages/agent-core set process.env.DATABASE_URL to a mock value and
  // never restore it, causing cross-test pollution in the same vitest process. Use
  // SKILL_NETWORKS_DATABASE_URL (never overwritten by any test) as the authoritative source.
  const realDbUrl = process.env.SKILL_NETWORKS_DATABASE_URL ?? process.env.DATABASE_URL
  const env = realDbUrl
    ? { ...process.env, DATABASE_URL: realDbUrl, DIRECT_URL: realDbUrl }
    : process.env
  const result = cp.spawnSync(cmd, args, {
    cwd: opts?.cwd ?? REPO_ROOT,
    encoding: 'utf-8',
    env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const err = new Error(
      `Command failed (exit ${result.status}): ${cmd} ${args.join(' ')}\n${String(result.stderr ?? '')}`,
    )
    ;(err as NodeJS.ErrnoException & { status?: number }).status = result.status ?? undefined
    throw err
  }
  return (result.stdout as string) ?? ''
}

/** Computes the lockfile hash the same way worktree.ts does. */
function lockfileHash(worktreePath: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(worktreePath, 'pnpm-lock.yaml')))
    .digest('hex')
}

/**
 * Scaffolds a new worktree directory with the minimum structure needed by
 * the provisioner (pnpm-lock.yaml, .install-hash sentinel, package stubs
 * with dist/.build-hash sentinels). Used both for the base tmpDir and for
 * the mock that intercepts `git worktree add`.
 */
function scaffoldWorktreeDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })

  // pnpm-lock.yaml — required by lockfileHash()
  fs.copyFileSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'), path.join(dir, 'pnpm-lock.yaml'))

  // node_modules/.install-hash — causes pnpm install to be skipped
  const nmDir = path.join(dir, 'node_modules')
  fs.mkdirSync(nmDir, { recursive: true })
  fs.writeFileSync(path.join(nmDir, '.install-hash'), lockfileHash(dir))

  // Required package stubs with build-hash sentinels so PnpmBuildAdapter skips all builds
  for (const rel of ['packages/logger', 'packages/agent-events', 'packages/agent-core']) {
    const pkgDir = path.join(dir, rel)
    fs.mkdirSync(pkgDir, { recursive: true })
    const pkgJson = JSON.stringify({ name: path.basename(rel), scripts: { build: 'tsc' } })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), pkgJson)
    const distDir = path.join(pkgDir, 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    // sourceHash hashes package.json + tsconfigs (no src/ here)
    const h = createHash('sha256')
    h.update('package.json\0')
    h.update(fs.readFileSync(path.join(pkgDir, 'package.json')))
    fs.writeFileSync(path.join(distDir, '.build-hash'), h.digest('hex'))
  }
}

/**
 * Returns the mock implementation used for fresh-provision tests:
 * - Intercepts `git worktree add` and scaffolds the target directory.
 * - Lets `pnpm exec agent-core process init` through to the real CLI.
 * - All other subprocess calls (pnpm install, build, agent-core --version) are no-ops.
 */
function makePassthroughMock() {
  return (cmd: string, args: readonly string[]): string | Buffer => {
    const argList = args as string[]

    // Intercept git worktree add — scaffold the target directory so the
    // provisioner can read pnpm-lock.yaml and find package stubs.
    if (cmd === 'git' && argList.includes('worktree') && argList.includes('add')) {
      const addIdx = argList.indexOf('add')
      const targetPath = argList[addIdx + 1]
      if (targetPath && !fs.existsSync(targetPath)) {
        scaffoldWorktreeDir(targetPath)
      }
      return ''
    }

    // Let real agent-core process init through — creates real DB rows (all fields set in one INSERT).
    if (
      cmd === 'pnpm' &&
      argList[0] === 'exec' &&
      argList[1] === 'agent-core' &&
      argList[2] === 'process' &&
      argList[3] === 'init'
    ) {
      return callRealCli(cmd, argList)
    }

    // All other calls are no-ops (pnpm install, pnpm run build, agent-core --version)
    return ''
  }
}

/** Reads EVAL_PROCESS_ID from a provision-output.env or .env file. */
function readProcessIdFromFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined
  const content = fs.readFileSync(filePath, 'utf-8')
  const match = content.match(/^EVAL_PROCESS_ID=["']?([^"'\n]+)["']?/m)
  return match?.[1]
}

/** Calls agent-core process status --id <id> --json and returns the parsed result. */
function getProcessStatus(processId: string): { status: string } {
  const raw = callRealCli(
    'pnpm',
    ['exec', 'agent-core', 'process', 'status', '--id', processId, '--json'],
  )
  return JSON.parse(raw.trim()) as { status: string }
}

/** Queries the DB for worktree_path on a process row via agent-core CLI. Returns null if not set. */
function getWorktreePath(processId: string): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(processId)) {
    throw new Error(`getWorktreePath: invalid processId: ${processId}`)
  }
  const result = callRealCli('pnpm', ['exec', 'agent-core', 'process', 'status', '--id', processId, '--json'])
  const parsed = JSON.parse(result.trim())
  return parsed.worktreePath ?? null
}

/** Marks a process as failed (test cleanup). */
function cleanupProcess(processId: string): void {
  try {
    callRealCli('pnpm', ['exec', 'agent-core', 'process', 'fail', '--id', processId, '--reason', 'test cleanup'])
  } catch {
    // Best-effort cleanup — non-fatal
  }
}

// ---------------------------------------------------------------------------
// Tests: worktree provisioner process ID integration
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('worktree provisioner — process ID integration', () => {
  let tmpDir: string
  let worktreePath: string
  let slug: string
  let ctx: ProvisionContext
  let provision: typeof import('../provisioners/worktree.js').provision
  let createdProcessId: string | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../provisioners/worktree.js')
    provision = mod.provision

    slug = `test-story7-${Date.now()}`
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-s7-'))
    // worktreePath will be created by the mock when git worktree add is intercepted
    worktreePath = path.join(tmpDir, slug)
    ctx = new ProvisionContext()
    createdProcessId = undefined
  })

  afterEach(() => {
    if (createdProcessId) {
      cleanupProcess(createdProcessId)
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  // ─── Test 1: Fresh provision ────────────────────────────────────────────

  it(
    'fresh provision: creates real DB row with status pending and writes EVAL_PROCESS_ID to both env files',
    async () => {
      // The fresh worktreePath does NOT exist — provisioner calls git worktree add
      // (mocked, scaffolds dir) then agent-core process init (real CLI).
      mockedExecFileSync.mockImplementation(makePassthroughMock() as never)

      await provision(ctx, slug, {
        repo: tmpDir,
        worktree: worktreePath,
        'base-dir': tmpDir,
        branch: `boot/${slug}`,
        'run-type': 'local',
        unlinked: 'true',
      })

      // ctx.processId must be a UUID
      expect(ctx.processId).toBeDefined()
      expect(ctx.processId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      createdProcessId = ctx.processId

      // Write env files (replicates what provision.ts main() does after registry.run())
      ctx.writeEnv()
      const outputEnvPath = path.join(worktreePath, 'provision-output.env')
      fs.writeFileSync(outputEnvPath, ctx.toShellEnv(), { encoding: 'utf-8', mode: 0o600 })

      // provision-output.env must contain EVAL_PROCESS_ID
      const idFromOutput = readProcessIdFromFile(outputEnvPath)
      expect(idFromOutput).toBe(ctx.processId)

      // <worktreePath>/.env must contain the same UUID
      const idFromEnv = readProcessIdFromFile(path.join(worktreePath, '.env'))
      expect(idFromEnv).toBe(ctx.processId)

      // Real DB row must have status "pending"
      const row = getProcessStatus(ctx.processId!)
      expect(row.status).toBe('pending')

      // Story 2: worktree_path must be written to DB by the provisioner
      const dbPath = getWorktreePath(ctx.processId!)
      expect(dbPath).toBe(worktreePath)
      expect(fs.existsSync(dbPath!)).toBe(true)
    },
    60_000,
  )

  // ─── Test 2: Re-provision is a no-op ────────────────────────────────────

  it(
    're-provision reads EVAL_PROCESS_ID from existing .env and does NOT call agent-core process init again',
    async () => {
      // First provision: fresh worktree — git worktree add is intercepted and scaffolds the dir
      mockedExecFileSync.mockImplementation(makePassthroughMock() as never)

      await provision(ctx, slug, {
        repo: tmpDir,
        worktree: worktreePath,
        'base-dir': tmpDir,
        branch: `boot/${slug}`,
        'run-type': 'local',
        unlinked: 'true',
      })

      expect(ctx.processId).toBeDefined()
      createdProcessId = ctx.processId
      const firstProcessId = ctx.processId!

      // Write .env so the second provision can read EVAL_PROCESS_ID
      ctx.writeEnv()

      const initCallsAfterFirst = mockedExecFileSync.mock.calls.filter(
        ([, args]) =>
          Array.isArray(args) &&
          (args as string[]).includes('process') &&
          (args as string[]).includes('init'),
      ).length
      expect(initCallsAfterFirst).toBe(1)

      // Second provision: worktreePath now exists, so provisioner reads .env instead of calling init
      vi.clearAllMocks()
      mockedExecFileSync.mockImplementation(makePassthroughMock() as never)

      const ctx2 = new ProvisionContext()
      await provision(ctx2, slug, {
        repo: tmpDir,
        worktree: worktreePath,
        'base-dir': tmpDir,
        branch: `boot/${slug}`,
        'run-type': 'local',
        unlinked: 'true',
      })

      // Must return the SAME UUID as the first run
      expect(ctx2.processId).toBe(firstProcessId)

      // agent-core process init must NOT have been called in the second run
      const initCallsAfterSecond = mockedExecFileSync.mock.calls.filter(
        ([, args]) =>
          Array.isArray(args) &&
          (args as string[]).includes('process') &&
          (args as string[]).includes('init'),
      ).length
      expect(initCallsAfterSecond).toBe(0)

      // provision-output.env must expose the same process ID
      ctx2.writeEnv()
      const outputEnvPath = path.join(worktreePath, 'provision-output.env')
      fs.writeFileSync(outputEnvPath, ctx2.toShellEnv(), { encoding: 'utf-8', mode: 0o600 })

      const idFromOutput = readProcessIdFromFile(outputEnvPath)
      expect(idFromOutput).toBe(firstProcessId)
    },
    60_000,
  )

  // ─── Test 3: DB unreachable ──────────────────────────────────────────────

  it(
    'DB unreachable: provision() rejects with an error and EVAL_PROCESS_ID is absent',
    async () => {
      const savedDatabaseUrl = process.env.DATABASE_URL
      const savedDirectUrl = process.env.DIRECT_URL
      const savedSkillNetworksDbUrl = process.env.SKILL_NETWORKS_DATABASE_URL

      try {
        // Override all DB URL env vars so agent-core process init fails to connect.
        // SKILL_NETWORKS_DATABASE_URL is also overridden because callRealCli prefers it
        // over DATABASE_URL (to avoid cross-test pollution from agent-core test mocks).
        process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/nonexistent'
        process.env.DIRECT_URL = 'postgres://invalid:invalid@127.0.0.1:1/nonexistent'
        process.env.SKILL_NETWORKS_DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/nonexistent'

        mockedExecFileSync.mockImplementation(makePassthroughMock() as never)

        await expect(
          provision(ctx, slug, {
            repo: tmpDir,
            worktree: worktreePath,
            'base-dir': tmpDir,
            branch: `boot/${slug}`,
            'run-type': 'local',
        unlinked: 'true',
          }),
        ).rejects.toThrow()

        // provision-output.env was never written — confirm no EVAL_PROCESS_ID
        const outputEnvPath = path.join(worktreePath, 'provision-output.env')
        const idFromOutput = readProcessIdFromFile(outputEnvPath)
        expect(idFromOutput).toBeUndefined()
      } finally {
        if (savedDatabaseUrl !== undefined) {
          process.env.DATABASE_URL = savedDatabaseUrl
        } else {
          delete process.env.DATABASE_URL
        }
        if (savedDirectUrl !== undefined) {
          process.env.DIRECT_URL = savedDirectUrl
        } else {
          delete process.env.DIRECT_URL
        }
        if (savedSkillNetworksDbUrl !== undefined) {
          process.env.SKILL_NETWORKS_DATABASE_URL = savedSkillNetworksDbUrl
        } else {
          delete process.env.SKILL_NETWORKS_DATABASE_URL
        }
      }
    },
    30_000,
  )
})

// ---------------------------------------------------------------------------
// Tests: launch.ts fails loudly when no process ID
// ---------------------------------------------------------------------------

describe('launch() — fails loudly with no process ID', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    savedEnv['EVAL_PROCESS_ID'] = process.env.EVAL_PROCESS_ID
    delete process.env.EVAL_PROCESS_ID
    // Mock execFileSync so tmux is not actually spawned
    mockedExecFileSync.mockReturnValue('' as never)
  })

  afterEach(() => {
    if (savedEnv['EVAL_PROCESS_ID'] !== undefined) {
      process.env.EVAL_PROCESS_ID = savedEnv['EVAL_PROCESS_ID']
    } else {
      delete process.env.EVAL_PROCESS_ID
    }
    vi.clearAllMocks()
  })

  it('throws when processId is undefined and EVAL_PROCESS_ID is not set', async () => {
    await expect(
      launch({
        slug: 'test-story7',
        worktreePath: '/tmp/test-story7',
        processId: undefined as unknown as string,
      }),
    ).rejects.toThrow('processId is required')
  })

  it('throws when processId is an empty string', async () => {
    await expect(
      launch({
        slug: 'test-story7',
        worktreePath: '/tmp/test-story7',
        processId: '',
      }),
    ).rejects.toThrow('processId is required')
  })
})

// ---------------------------------------------------------------------------
// Tests: multi-run integration — 3 distinct processes with lifecycle transitions
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('multi-run integration — 3 distinct processes with lifecycle transitions', () => {
  let tmpDir: string
  let provision: typeof import('../provisioners/worktree.js').provision
  let createdProcessIds: string[] = []

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../provisioners/worktree.js')
    provision = mod.provision
    createdProcessIds = []
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-multi-'))
  })

  afterEach(() => {
    for (const id of createdProcessIds) {
      cleanupProcess(id)
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  /**
   * Helper: provision a single worktree and return its process ID and worktree path.
   */
  async function provisionOne(slug: string): Promise<{ processId: string; worktreePath: string }> {
    const worktreePath = path.join(tmpDir, slug)
    const ctx = new ProvisionContext()

    mockedExecFileSync.mockImplementation(makePassthroughMock() as never)

    await provision(ctx, slug, {
      repo: tmpDir,
      worktree: worktreePath,
      'base-dir': tmpDir,
      branch: `boot/${slug}`,
      'run-type': 'local',
        unlinked: 'true',
    })

    expect(ctx.processId).toBeDefined()
    const processId = ctx.processId!
    createdProcessIds.push(processId)

    // Write env files
    ctx.writeEnv()
    const outputEnvPath = path.join(worktreePath, 'provision-output.env')
    fs.writeFileSync(outputEnvPath, ctx.toShellEnv(), { encoding: 'utf-8', mode: 0o600 })

    return { processId, worktreePath }
  }

  // ─── Test 1: 3 distinct worktrees get distinct process IDs in pending state ──

  it(
    'provisions 3 distinct worktrees and all get distinct process IDs in pending state',
    async () => {
      const now = Date.now()
      const slugs = [
        `test-multi-${now}-1`,
        `test-multi-${now}-2`,
        `test-multi-${now}-3`,
      ]

      const results = []
      for (const slug of slugs) {
        vi.clearAllMocks()
        results.push(await provisionOne(slug))
      }

      const ids = results.map((r) => r.processId)

      // All 3 IDs are valid UUIDs
      for (const id of ids) {
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        )
      }

      // All 3 IDs are distinct
      expect(new Set(ids).size).toBe(3)

      // All 3 are in pending status
      for (const id of ids) {
        const row = getProcessStatus(id)
        expect(row.status).toBe('pending')
      }

      // Verify EVAL_PROCESS_ID written to both env files for each
      for (const { processId, worktreePath } of results) {
        const outputId = readProcessIdFromFile(path.join(worktreePath, 'provision-output.env'))
        expect(outputId).toBe(processId)
        const envId = readProcessIdFromFile(path.join(worktreePath, '.env'))
        expect(envId).toBe(processId)
      }
    },
    60_000,
  )

  // ─── Test 2: lifecycle transitions produce correct terminal statuses ──────

  it(
    'lifecycle transitions produce correct terminal statuses (completed, failed, completed)',
    async () => {
      const now = Date.now()
      const slugs = [
        `test-multi-${now}-a1`,
        `test-multi-${now}-a2`,
        `test-multi-${now}-a3`,
      ]

      const results = []
      for (const slug of slugs) {
        vi.clearAllMocks()
        results.push(await provisionOne(slug))
      }

      const [p1, p2, p3] = results

      // All start as pending
      for (const { processId } of results) {
        expect(getProcessStatus(processId).status).toBe('pending')
      }

      // Process 1: pending → active → completed
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'active', '--id', p1.processId])
      expect(getProcessStatus(p1.processId).status).toBe('active')
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'complete', '--id', p1.processId])

      // Process 2: pending → active → failed
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'active', '--id', p2.processId])
      expect(getProcessStatus(p2.processId).status).toBe('active')
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'fail', '--id', p2.processId, '--reason', 'loop exited with code 1'])

      // Process 3: pending → active → completed
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'active', '--id', p3.processId])
      expect(getProcessStatus(p3.processId).status).toBe('active')
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'complete', '--id', p3.processId])

      // Verify terminal statuses
      expect(getProcessStatus(p1.processId).status).toBe('completed')
      expect(getProcessStatus(p2.processId).status).toBe('failed')
      expect(getProcessStatus(p3.processId).status).toBe('completed')

      // All 3 IDs are distinct
      const ids = results.map((r) => r.processId)
      expect(new Set(ids).size).toBe(3)

      // None stuck at pending or active
      for (const id of ids) {
        const { status } = getProcessStatus(id)
        expect(status).not.toBe('pending')
        expect(status).not.toBe('active')
      }
    },
    60_000,
  )

  // ─── Test 3: all 3 process rows coexist in DB with distinct IDs ───────────

  it(
    'all 3 process rows coexist in DB with distinct IDs after lifecycle transitions',
    async () => {
      const now = Date.now()
      const slugs = [
        `test-multi-${now}-b1`,
        `test-multi-${now}-b2`,
        `test-multi-${now}-b3`,
      ]

      const results = []
      for (const slug of slugs) {
        vi.clearAllMocks()
        results.push(await provisionOne(slug))
      }

      const [p1, p2, p3] = results

      // Transition all through lifecycle
      // Process 1: → active → completed
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'active', '--id', p1.processId])
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'complete', '--id', p1.processId])

      // Process 2: → active → failed
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'active', '--id', p2.processId])
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'fail', '--id', p2.processId, '--reason', 'loop exited with code 1'])

      // Process 3: → active → completed
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'active', '--id', p3.processId])
      callRealCli('pnpm', ['exec', 'agent-core', 'process', 'complete', '--id', p3.processId])

      // All 3 IDs are distinct (no duplicates)
      const ids = results.map((r) => r.processId)
      expect(ids[0]).not.toBe(ids[1])
      expect(ids[0]).not.toBe(ids[2])
      expect(ids[1]).not.toBe(ids[2])

      // Each ID returns a valid status from the DB
      const statuses = ids.map((id) => getProcessStatus(id))
      expect(statuses[0].status).toBe('completed')
      expect(statuses[1].status).toBe('failed')
      expect(statuses[2].status).toBe('completed')

      // All statuses are terminal (not pending or active)
      for (const s of statuses) {
        expect(['completed', 'failed']).toContain(s.status)
      }
    },
    60_000,
  )
})
