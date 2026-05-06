// Mock modules BEFORE imports
vi.mock('child_process', () => {
  // spawn mock: returns a minimal event-emitter-like child that exits with code 0
  const mockSpawn = vi.fn(() => ({
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'exit') {
        // Fire on next tick so the Promise chain can settle
        setImmediate(() => cb(0, null))
      }
      // 'error' handler stored but never fired — mock always succeeds
    },
  }))
  return {
    execFileSync: vi.fn(),
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, '', '')
    }),
    spawn: mockSpawn,
  }
})
vi.mock('../steps/launch.js', () => ({ launch: vi.fn() }))
// Note: 'fs' does NOT need to be mocked — tests control DISPATCH_BASE_DIR and write real files

import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { launch } from '../steps/launch.js'
import { validateSkillConfig, collect, dispatchRun, type CronSkillConfig } from '../dispatch.js'

const validConfig: CronSkillConfig = {
  metric: 'followers',
  content: 'Collect follower count',
  epochs: 3,
  worktree: true,
  git: true,
  pr: false,
}

const validConfigWithoutMetric: CronSkillConfig = {
  content: 'Collect follower count',
  epochs: 3,
  worktree: true,
  git: true,
  pr: false,
}

describe('validateSkillConfig', () => {
  it('returns false for null', () => {
    expect(validateSkillConfig(null)).toBe(false)
  })

  it('returns false for non-object', () => {
    expect(validateSkillConfig('string')).toBe(false)
    expect(validateSkillConfig(42)).toBe(false)
  })

  it('returns false when required fields are missing (content, epochs, worktree, git)', () => {
    expect(validateSkillConfig({})).toBe(false)
    expect(validateSkillConfig({ content: 'x' })).toBe(false)
    expect(validateSkillConfig({ content: 'x', epochs: 3 })).toBe(false)
    expect(validateSkillConfig({ content: 'x', epochs: 3, worktree: true })).toBe(false)
    // pr is optional — config without pr is valid
    expect(validateSkillConfig({ content: 'x', epochs: 3, worktree: true, git: true })).toBe(true)
  })

  it('returns false when pr is present but wrong type', () => {
    expect(validateSkillConfig({ ...validConfig, pr: 'yes' })).toBe(false)
    expect(validateSkillConfig({ ...validConfig, pr: 1 })).toBe(false)
  })

  it('returns false when metric is present but wrong type (e.g. number)', () => {
    expect(validateSkillConfig({ ...validConfig, metric: 123 })).toBe(false)
    expect(validateSkillConfig({ ...validConfig, metric: true })).toBe(false)
    expect(validateSkillConfig({ ...validConfig, metric: null })).toBe(false)
  })

  it('returns true when metric is absent (metric-optional)', () => {
    expect(validateSkillConfig(validConfigWithoutMetric)).toBe(true)
  })

  it('returns true when metric is a valid string', () => {
    expect(validateSkillConfig({ ...validConfigWithoutMetric, metric: 'followers' })).toBe(true)
  })

  it('returns true for a full valid config', () => {
    expect(validateSkillConfig(validConfig)).toBe(true)
  })

  it('returns true with extra fields present', () => {
    expect(validateSkillConfig({ ...validConfig, extra: 'ok' })).toBe(true)
  })
})

describe('collect', () => {
  let tmpBase: string
  let originalDispatchBaseDir: string | undefined

  let originalWorktreeRepo: string | undefined

  beforeEach(() => {
    tmpBase = join(tmpdir(), `dispatch-collect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpBase, { recursive: true })
    originalDispatchBaseDir = process.env.DISPATCH_BASE_DIR
    process.env.DISPATCH_BASE_DIR = tmpBase
    originalWorktreeRepo = process.env.WORKTREE_REPO
    delete process.env.WORKTREE_REPO
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalDispatchBaseDir === undefined) {
      delete process.env.DISPATCH_BASE_DIR
    } else {
      process.env.DISPATCH_BASE_DIR = originalDispatchBaseDir
    }
    if (originalWorktreeRepo === undefined) {
      delete process.env.WORKTREE_REPO
    } else {
      process.env.WORKTREE_REPO = originalWorktreeRepo
    }
    rmSync(tmpBase, { recursive: true, force: true })
  })

  function writeProvisionOutput(skillId: string, content?: string): void {
    const slug = skillId.slice(0, 8)
    const outputDir = join(tmpBase, slug)
    mkdirSync(outputDir, { recursive: true })
    const defaultContent = [
      'WORKTREE_PATH="/tmp/fake-worktree"',
      'EVAL_PROCESS_ID="12345678-1234-1234-1234-123456789abc"',
    ].join('\n')
    writeFileSync(join(outputDir, 'provision-output.env'), content ?? defaultContent, 'utf-8')
  }

  it('returns failed and logs warning for invalid config', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await collect({ metric: 123 } as unknown as CronSkillConfig, 'skill-abc')

    expect(result).toBe('failed')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid skill config'))
    expect(execFile).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns failed and logs warning for non-UUID skillId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await collect(validConfig, 'not-a-uuid')

    expect(result).toBe('failed')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('requires a UUID skillId'))
    expect(execFile).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('calls spawn with provision subprocess args (including --slug, --skill-resource-id, --provision worktree, --provision compose)', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    writeProvisionOutput(skillId)

    await collect(validConfig, skillId)

    // In the test environment the prebuilt bundle (provision.prebuilt.mjs) is not present,
    // so dispatch falls back to `npx tsx provision.ts`. In production (Docker) the bundle
    // is built by build-bundles.mjs and `node provision.prebuilt.mjs` is used instead.
    const firstCall = (vi.mocked(spawn).mock.calls[0] as unknown[])
    const cmd = firstCall[0] as string
    const args = firstCall[1] as string[]

    // Either the prebuilt bundle (node) or the tsx fallback must be used — no other options.
    const useBundle = cmd === 'node'
    if (useBundle) {
      expect(args[0]).toEqual(expect.stringContaining('provision.prebuilt.mjs'))
    } else {
      expect(cmd).toBe('npx')
      expect(args[0]).toBe('tsx')
      expect(args[1]).toContain('provision.ts')
    }

    // Remaining args are the same regardless of runner
    const provisionArgOffset = useBundle ? 1 : 2
    expect(args.slice(provisionArgOffset)).toEqual([
      '--slug', skillId.slice(0, 8),
      '--skill-resource-id', skillId,
      '--provision', 'worktree',
      '--provision', 'compose',
      '--base-dir', tmpBase,
    ])
    // env: process.env and stdio: 'inherit' are forwarded via spawnInherit
    expect(firstCall[2]).toEqual({ stdio: 'inherit', cwd: '/root/repos/outcomes-optimizer', env: process.env })
  })

  it('reads EVAL_PROCESS_ID from provision-output.env', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    writeProvisionOutput(skillId)

    await collect(validConfig, skillId)

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      processId: '12345678-1234-1234-1234-123456789abc',
    }))
  })

  it('calls launch() with { slug, worktreePath, processId, skillResourceId, maxEpochs }', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    writeProvisionOutput(skillId)

    await collect(validConfig, skillId)

    expect(launch).toHaveBeenCalledWith({
      slug: skillId.slice(0, 8),
      worktreePath: '/tmp/fake-worktree',
      processId: '12345678-1234-1234-1234-123456789abc',
      skillResourceId: skillId,
      maxEpochs: validConfig.epochs,
      pr: validConfig.pr,
    })
  })

  it('returns completed on success', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    writeProvisionOutput(skillId)

    const result = await collect(validConfig, skillId)

    expect(result).toBe('completed')
  })

  it('returns failed when provision-output.env not found', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Do not write provision-output.env

    const result = await collect(validConfig, skillId)

    expect(result).toBe('failed')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('provision-output.env not found'))
    warnSpy.mockRestore()
  })

  it('returns failed when EVAL_PROCESS_ID missing from env file', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    writeProvisionOutput(skillId, 'WORKTREE_PATH="/tmp/fake-worktree"\n')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await collect(validConfig, skillId)

    expect(result).toBe('failed')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EVAL_PROCESS_ID not found'))
    warnSpy.mockRestore()
  })

  it('returns failed when WORKTREE_PATH missing from env file', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    writeProvisionOutput(skillId, 'EVAL_PROCESS_ID="12345678-1234-1234-1234-123456789abc"\n')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await collect(validConfig, skillId)

    expect(result).toBe('failed')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WORKTREE_PATH not found'))
    warnSpy.mockRestore()
  })

  it('works correctly with metric absent (metric-optional config)', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    writeProvisionOutput(skillId)

    const result = await collect(validConfigWithoutMetric, skillId)

    expect(result).toBe('completed')
    expect(launch).toHaveBeenCalledWith({
      slug: skillId.slice(0, 8),
      worktreePath: '/tmp/fake-worktree',
      processId: '12345678-1234-1234-1234-123456789abc',
      skillResourceId: skillId,
      maxEpochs: validConfigWithoutMetric.epochs,
      pr: validConfigWithoutMetric.pr,
    })
  })

  describe('fail-fast cleanup on launch() throw', () => {
    let mockFetch: ReturnType<typeof vi.fn>
    let originalSupabaseUrl: string | undefined
    let originalSupabaseServiceKey: string | undefined

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', mockFetch)
      originalSupabaseUrl = process.env.SUPABASE_URL
      originalSupabaseServiceKey = process.env.SUPABASE_SERVICE_KEY
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      if (originalSupabaseUrl === undefined) {
        delete process.env.SUPABASE_URL
      } else {
        process.env.SUPABASE_URL = originalSupabaseUrl
      }
      if (originalSupabaseServiceKey === undefined) {
        delete process.env.SUPABASE_SERVICE_KEY
      } else {
        process.env.SUPABASE_SERVICE_KEY = originalSupabaseServiceKey
      }
    })

    it('calls fail_process RPC via fetch when launch() throws and SUPABASE env vars are set', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      process.env.SUPABASE_SERVICE_KEY = 'test-service-key'
      const launchError = new Error('launch failed deliberately')
      vi.mocked(launch).mockRejectedValueOnce(launchError)

      await expect(collect(validConfig, skillId)).rejects.toThrow('launch failed deliberately')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/rpc/fail_process',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            apikey: 'test-service-key',
            Authorization: 'Bearer test-service-key',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            p_process_id: '12345678-1234-1234-1234-123456789abc',
            p_reason: 'launch failed deliberately',
          }),
        }),
      )
    })

    it('does NOT call fetch when launch() throws and SUPABASE env vars are NOT set', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_KEY
      vi.mocked(launch).mockRejectedValueOnce(new Error('launch failed'))

      await expect(collect(validConfig, skillId)).rejects.toThrow('launch failed')

      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('re-throws the original error after calling fail_process', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      process.env.SUPABASE_SERVICE_KEY = 'test-service-key'
      const originalError = new Error('original launch error')
      vi.mocked(launch).mockRejectedValueOnce(originalError)

      const thrown = await collect(validConfig, skillId).catch((e: unknown) => e)

      expect(thrown).toBe(originalError)
    })
  })

  describe('DUOIDAL_RUN_TYPE env threading', () => {
    let originalRunType: string | undefined

    beforeEach(() => {
      originalRunType = process.env.DUOIDAL_RUN_TYPE
      delete process.env.DUOIDAL_RUN_TYPE
    })

    afterEach(() => {
      if (originalRunType === undefined) {
        delete process.env.DUOIDAL_RUN_TYPE
      } else {
        process.env.DUOIDAL_RUN_TYPE = originalRunType
      }
    })

    it('forwards --run-type cloud to provision.ts when DUOIDAL_RUN_TYPE is set (remote dispatch inside container)', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)
      // Simulate the env var set by waypoint-router's docker exec -e flag
      process.env.DUOIDAL_RUN_TYPE = 'openclaw'

      await collect(validConfig, skillId)

      // provision.ts receives --run-type cloud (run_type CHECK constraint allows
      // 'cloud'|'local'|'moltbot' — any remote server name maps to 'cloud').
      const callArgs = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
      expect(callArgs).toBeDefined()
      expect(callArgs).toContain('--run-type')
      const rtIdx = callArgs!.indexOf('--run-type')
      expect(callArgs![rtIdx + 1]).toBe('cloud')
    })

    it('does NOT forward --run-type when DUOIDAL_RUN_TYPE is unset (preserves today\'s local-default behavior)', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)
      // No DUOIDAL_RUN_TYPE env set — classic server:self local-tmux path

      await collect(validConfig, skillId)

      const callArgs = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
      expect(callArgs).toBeDefined()
      expect(callArgs).not.toContain('--run-type')
    })

    it('does NOT forward --run-type when DUOIDAL_RUN_TYPE is an empty string (defensive)', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)
      process.env.DUOIDAL_RUN_TYPE = ''

      await collect(validConfig, skillId)

      const callArgs = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
      expect(callArgs).toBeDefined()
      expect(callArgs).not.toContain('--run-type')
    })
  })

  describe('opts.provisions validation', () => {
    it('passes multiple provisioners from opts.provisions', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)

      await collect(validConfig, skillId, { provisions: ['worktree', 'dashboard'] })

      const firstCall = (vi.mocked(spawn).mock.calls[0] as unknown[])
      const cmd = firstCall[0] as string
      const args = firstCall[1] as string[]
      const useBundle = cmd === 'node'
      const provisionArgOffset = useBundle ? 1 : 2

      expect(args.slice(provisionArgOffset)).toEqual([
        '--slug', skillId.slice(0, 8),
        '--skill-resource-id', skillId,
        '--provision', 'worktree',
        '--provision', 'dashboard',
        '--base-dir', tmpBase,
      ])
    })

    it('throws for invalid provisioner names containing --', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)

      await expect(collect(validConfig, skillId, { provisions: ['--slug'] })).rejects.toThrow('Invalid provisioner name')
    })

    it('throws for provisioner names with path separators', async () => {
      const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
      writeProvisionOutput(skillId)

      await expect(collect(validConfig, skillId, { provisions: ['worktree/evil'] })).rejects.toThrow('Invalid provisioner name')
    })
  })
})

describe('dispatchRun', () => {
  let tmpBase: string
  let originalDispatchBaseDir: string | undefined

  beforeEach(() => {
    tmpBase = join(tmpdir(), `dispatch-collect-row-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpBase, { recursive: true })
    originalDispatchBaseDir = process.env.DISPATCH_BASE_DIR
    process.env.DISPATCH_BASE_DIR = tmpBase
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalDispatchBaseDir === undefined) {
      delete process.env.DISPATCH_BASE_DIR
    } else {
      process.env.DISPATCH_BASE_DIR = originalDispatchBaseDir
    }
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it('delegates to collect with row fields', async () => {
    const skillId = 'abcdef12-1234-1234-1234-567890abcdef'
    const baseSlug = skillId.slice(0, 8)
    // dispatchRun passes fresh:true which appends a timestamp suffix to the slug.
    // Pin Date.now() so the suffix is deterministic and we can pre-create the correct dir.
    const fixedNow = 1_000_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
    const suffix = fixedNow.toString(36).slice(-5)
    const slug = `${baseSlug}-${suffix}`
    const outputDir = join(tmpBase, slug)
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(
      join(outputDir, 'provision-output.env'),
      'WORKTREE_PATH="/tmp/fake-worktree"\nEVAL_PROCESS_ID="12345678-1234-1234-1234-123456789abc"\n',
      'utf-8',
    )

    const result = await dispatchRun({
      skill_id: skillId,
      skill_config: validConfig,
    })

    expect(result).toBe('completed')
    expect(launch).toHaveBeenCalledTimes(1)
  })
})
