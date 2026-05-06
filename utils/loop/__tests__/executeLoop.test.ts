import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import * as childProcess from 'child_process'
import { createWatchdog } from '@skill-networks/agent-events'

// Mock agent-events to prevent real Supabase calls
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

// Mock the run module before importing executeLoop
vi.mock('../../run', () => ({
  run: vi.fn().mockResolvedValue({
    sync: [],
    execution: {
      command: ['echo', 'mock'],
      output: {
        sessionId: `mock-session-${Date.now()}`,
        success: true,
        rawOutput: 'mock output',
      },
      durationMs: 100,
      exitCode: 0,
    },
  }),
}))

// Allow tests to control execFileSync for checkWaitingStatus
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), execSync: actual.execSync }
})

import { executeLoop } from '../index.js'

describe('executeLoop', () => {
  const testDir = join(tmpdir(), 'ralph-loop-test')
  const workspaceDir = join(testDir, 'workspace')

  let savedProcessId: string | undefined
  let savedCampaignId: string | undefined
  let savedEvalBranch: string | undefined
  let savedSupabaseUrl: string | undefined
  let savedSupabaseKey: string | undefined

  beforeEach(() => {
    mkdirSync(workspaceDir, { recursive: true })
    // Isolate from any EVAL_PROCESS_ID / EVAL_CAMPAIGN_ID / EVAL_BRANCH set in the test runner
    // environment to prevent checkWaitingStatus from making real network calls and
    // commitEpoch from running real git commands (which causes timeout on multi-epoch tests).
    savedProcessId = process.env.EVAL_PROCESS_ID
    savedCampaignId = process.env.EVAL_CAMPAIGN_ID
    savedEvalBranch = process.env.EVAL_BRANCH
    savedSupabaseUrl = process.env.SUPABASE_URL
    savedSupabaseKey = process.env.SUPABASE_SERVICE_KEY
    delete process.env.EVAL_PROCESS_ID
    delete process.env.EVAL_CAMPAIGN_ID
    delete process.env.EVAL_BRANCH
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
    vi.mocked(childProcess.execFileSync).mockReset()
    // Restore env vars so other test suites are unaffected.
    if (savedProcessId !== undefined) process.env.EVAL_PROCESS_ID = savedProcessId
    else delete process.env.EVAL_PROCESS_ID
    if (savedCampaignId !== undefined) process.env.EVAL_CAMPAIGN_ID = savedCampaignId
    else delete process.env.EVAL_CAMPAIGN_ID
    if (savedEvalBranch !== undefined) process.env.EVAL_BRANCH = savedEvalBranch
    else delete process.env.EVAL_BRANCH
    if (savedSupabaseUrl !== undefined) process.env.SUPABASE_URL = savedSupabaseUrl
    else delete process.env.SUPABASE_URL
    if (savedSupabaseKey !== undefined) process.env.SUPABASE_SERVICE_KEY = savedSupabaseKey
    else delete process.env.SUPABASE_SERVICE_KEY
  })

  it('stops when COMPLETE signal found in progress.md', async () => {
    // Pre-create progress.md with COMPLETE signal
    writeFileSync(join(workspaceDir, 'progress.md'), 'COMPLETE\n\nAll done!')

    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 5,
      workspaceDir,
    })

    expect(result.completed).toBe(true)
    expect(result.epochs).toBe(1) // Stops on first epoch after seeing COMPLETE
    expect(result.epochLimitReached).toBeUndefined()
  })

  it('stops when **COMPLETE** (markdown bold) signal found in progress.md', async () => {
    // Agents often write **COMPLETE** rather than bare COMPLETE
    writeFileSync(join(workspaceDir, 'progress.md'), '# Progress Log\n\n**Goal**: test\n**Started**: 2024-01-01\n\n---\n**COMPLETE**\n\nAll done!')

    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 5,
      workspaceDir,
    })

    expect(result.completed).toBe(true)
  })

  it('stops when **COMPLETE** has trailing text on same line', async () => {
    // Agents often append context after COMPLETE, e.g. "**COMPLETE** — all stories passed"
    writeFileSync(join(workspaceDir, 'progress.md'), '# Progress Log\n\n**COMPLETE** — all 5 stories passed, PR #306 open\n\nDetails...')

    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 5,
      workspaceDir,
    })

    expect(result.completed).toBe(true)
  })

  it('detects COMPLETE signal after 600-line preamble (regression for slice-10 bug)', async () => {
    // Simulate progress.md with a 600-line goal preamble (as produced by poller-service.ts)
    // followed by the COMPLETE signal written by the agent at the end
    const preamble = Array(600).fill('preamble line').join('\n')
    writeFileSync(join(workspaceDir, 'progress.md'), preamble + '\n**COMPLETE**\n\nAll stories passed.')
    const result = await executeLoop({ goal: 'Test goal', workspaceDir, maxEpochs: 3 })
    // Loop should detect COMPLETE after the first run that finds it and stop
    expect(result.completed).toBe(true)
  })

  it('does not false-positive on INCOMPLETE in progress.md', async () => {
    writeFileSync(join(workspaceDir, 'progress.md'), 'Task INCOMPLETE - still working\n')

    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 1,
      workspaceDir,
    })

    expect(result.completed).toBe(false)
  })

  it('creates workspace files on first run', async () => {
    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 1,
      workspaceDir,
    })

    expect(existsSync(join(workspaceDir, 'progress.md'))).toBe(true)
    expect(existsSync(join(workspaceDir, 'prompts'))).toBe(true)
    expect(existsSync(join(workspaceDir, 'sessions.txt'))).toBe(true)
    // Note: state.json is created by the agent, not the loop orchestrator
  })

  it('records session IDs in sessions.txt', async () => {
    await executeLoop({
      goal: 'Test goal',
      maxEpochs: 2,
      workspaceDir,
    })

    const sessions = readFileSync(join(workspaceDir, 'sessions.txt'), 'utf-8')
    const lines = sessions.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/^mock-session-/)
  })

  it('returns correct epoch count at max epochs', async () => {
    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 3,
      workspaceDir,
    })

    expect(result.completed).toBe(false)
    // No state.json → starts at epoch 1, runs 3 sessions → last epoch is 3
    expect(result.epochs).toBe(3)
    expect(result.sessionIds.length).toBe(3)
  })

  it('sets epochLimitReached:true when epoch budget exhausted without COMPLETE', async () => {
    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 2,
      workspaceDir,
    })

    expect(result.completed).toBe(false)
    expect(result.epochLimitReached).toBe(true)
    expect(result.sleeping).toBeUndefined()
  })

  it('continues epoch count from state.json', async () => {
    // Pre-create state.json at epoch 5
    writeFileSync(join(workspaceDir, 'state.json'), JSON.stringify({
      epoch: 5,
      status: 'completed',
      goal: 'Test goal',
    }))

    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 3,
      workspaceDir,
    })

    expect(result.completed).toBe(false)
    // Starts at epoch 6 (5+1), runs 3 sessions → last epoch is 8
    expect(result.epochs).toBe(8)
    expect(result.sessionIds.length).toBe(3)
  })

  it('saves prompts to prompts directory', async () => {
    await executeLoop({
      goal: 'Test goal',
      maxEpochs: 1,
      workspaceDir,
    })

    const promptsDir = join(workspaceDir, 'prompts')
    const promptFiles = readdirSync(promptsDir)
    expect(promptFiles.length).toBe(1)
    expect(promptFiles[0]).toMatch(/^epoch-1-/)
  })

  it('writes epoch logs with cumulative numbering', async () => {
    await executeLoop({
      goal: 'Test goal',
      maxEpochs: 2,
      workspaceDir,
    })

    // No state.json → starts at epoch 1
    expect(existsSync(join(workspaceDir, 'epoch-1.log'))).toBe(true)
    expect(existsSync(join(workspaceDir, 'epoch-2.log'))).toBe(true)
  })

  it('writes epoch logs with offset numbering when resuming', async () => {
    writeFileSync(join(workspaceDir, 'state.json'), JSON.stringify({
      epoch: 10,
      status: 'completed',
      goal: 'Test goal',
    }))

    await executeLoop({
      goal: 'Test goal',
      maxEpochs: 2,
      workspaceDir,
    })

    // Resumes at epoch 11, runs 2 sessions
    expect(existsSync(join(workspaceDir, 'epoch-11.log'))).toBe(true)
    expect(existsSync(join(workspaceDir, 'epoch-12.log'))).toBe(true)
    // Should NOT have epoch-1.log
    expect(existsSync(join(workspaceDir, 'epoch-1.log'))).toBe(false)
  })

  it('falls back to epoch 1 when state.json is corrupted', async () => {
    writeFileSync(join(workspaceDir, 'state.json'), '{invalid json')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 1,
      workspaceDir,
    })

    expect(result.epochs).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not be parsed'))
    warnSpy.mockRestore()
  })

  it('starts at epoch 1 when state.epoch is 0', async () => {
    writeFileSync(join(workspaceDir, 'state.json'), JSON.stringify({ epoch: 0, status: 'completed' }))

    const result = await executeLoop({
      goal: 'Test goal',
      maxEpochs: 1,
      workspaceDir,
    })

    expect(result.epochs).toBe(1)
  })

  it('warns when testSetPath does not exist', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await executeLoop({
      goal: 'Test goal',
      maxEpochs: 1,
      workspaceDir,
      testSetPath: '/nonexistent/path',
    })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('testSetPath does not exist'))
    warnSpy.mockRestore()
  })

  it('returns sleeping:true and exits cleanly before first epoch when process is waiting', async () => {
    // Set a valid UUID so checkWaitingStatus makes the execFileSync call
    process.env.EVAL_PROCESS_ID = '00000000-0000-0000-0000-000000000001'
    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    // First call is enrichProcessEnv, second is process active, third is checkWaitingStatus
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify({ name: 'test-proc', skillResourceId: null }))
      .mockReturnValueOnce('')  // process active
      .mockReturnValueOnce(JSON.stringify({ status: 'waiting', resumeAt: '2099-01-01T00:00:00Z' }))

    const result = await executeLoop({ goal: 'Test goal', maxEpochs: 5, workspaceDir })

    expect(result.sleeping).toBe(true)
    expect(result.completed).toBe(false)
    // Pre-epoch check: epochs should be startEpoch - 1 = 0
    expect(result.epochs).toBe(0)
  })

  it('returns sleeping:true and exits cleanly after an epoch when process is waiting', async () => {
    process.env.EVAL_PROCESS_ID = '00000000-0000-0000-0000-000000000002'
    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    // First call: enrichProcessEnv; second: process active; third: pre-epoch check → not waiting; fourth: post-epoch check → waiting
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify({ name: 'test-proc', skillResourceId: null }))
      .mockReturnValueOnce('')  // process active
      .mockReturnValueOnce(JSON.stringify({ status: 'running' }))
      .mockReturnValueOnce(JSON.stringify({ status: 'waiting', resumeAt: '2099-01-01T00:00:00Z' }))

    const result = await executeLoop({ goal: 'Test goal', maxEpochs: 5, workspaceDir })

    expect(result.sleeping).toBe(true)
    expect(result.completed).toBe(false)
    // Post-epoch check: epoch 1 completed, so epochs = 1
    expect(result.epochs).toBe(1)
  })

  it('T8 — marks process as completed in DB when COMPLETE signal detected', async () => {
    const processId = '00000000-0000-0000-0000-000000000099'
    const supabaseUrl = 'https://test.supabase.co'

    process.env.EVAL_PROCESS_ID = processId
    process.env.SUPABASE_URL = supabaseUrl
    process.env.SUPABASE_SERVICE_KEY = 'test-key'

    // Track fetch calls
    const fetchCalls: Array<{ url: string; method: string; body: string }> = []
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', mockFetch)

    // Mock execFileSync so enrichProcessEnv and checkWaitingStatus don't make real calls
    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    execFileSyncMock.mockReturnValue(JSON.stringify({ name: 'test-proc', skillResourceId: null, status: 'running' }))

    // Mock run() so the agent writes COMPLETE on first run
    const { run } = await import('../../run/index.js')
    const runMock = vi.mocked(run)
    runMock.mockImplementationOnce(async () => {
      // Write COMPLETE signal during "agent run"
      writeFileSync(join(workspaceDir, 'progress.md'), 'COMPLETE\n\nAll done!')
      return {
        sync: [],
        execution: {
          command: ['echo', 'mock'],
          output: {
            sessionId: 'mock-session-t8',
            success: true,
            rawOutput: 'mock output',
          },
          durationMs: 100,
          exitCode: 0,
        },
      }
    })

    const result = await executeLoop({
      goal: 'Test goal T8',
      maxEpochs: 3,
      workspaceDir,
      git: false,
    })

    expect(result.completed).toBe(true)

    // Must have called fetch to PATCH processes status to 'completed'
    const patchCall = fetchCalls.find(
      (c) => c.method === 'PATCH' && c.url.includes('processes') && c.url.includes(processId),
    )
    expect(patchCall).toBeDefined()
    const patchBody = JSON.parse(patchCall!.body)
    expect(patchBody.status).toBe('completed')

  })

  it('calls createWatchdog() on loop start and stop() on loop completion', async () => {
    const processId = '00000000-0000-0000-0000-000000000010'
    process.env.EVAL_PROCESS_ID = processId
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'test-key'

    // Mock fetch for markProcessCompleted
    const mockFetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', mockFetch)

    // Mock execFileSync for enrichProcessEnv, process active, checkWaitingStatus
    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    execFileSyncMock.mockReturnValue(JSON.stringify({ name: 'test-proc', skillResourceId: null, status: 'running' }))

    // Mock run to write COMPLETE signal
    const { run } = await import('../../run/index.js')
    const runMock = vi.mocked(run)
    runMock.mockImplementationOnce(async () => {
      writeFileSync(join(workspaceDir, 'progress.md'), 'COMPLETE\n\nAll done!')
      return {
        sync: [],
        execution: {
          command: ['echo', 'mock'],
          output: { sessionId: 'mock-session-watchdog', success: true, rawOutput: '' },
          durationMs: 100,
          exitCode: 0,
        },
      }
    })

    // Clear createWatchdog mock to reset call count from previous tests
    vi.mocked(createWatchdog).mockClear()

    await executeLoop({ goal: 'Test goal', maxEpochs: 1, workspaceDir, git: false })

    // Assert createWatchdog was called once with the correct process ID
    expect(vi.mocked(createWatchdog)).toHaveBeenCalledOnce()
    expect(vi.mocked(createWatchdog)).toHaveBeenCalledWith(processId)

    // Assert stop() was called exactly once (in finally block)
    const stopSpy = vi.mocked(createWatchdog).mock.results[0].value.stop
    expect(stopSpy).toHaveBeenCalledOnce()
  })

  it('calls watchdog.stop() on error exit (finally block runs)', async () => {
    const processId = '00000000-0000-0000-0000-000000000011'
    process.env.EVAL_PROCESS_ID = processId

    // Mock execFileSync for enrichProcessEnv
    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    execFileSyncMock.mockReturnValue(JSON.stringify({ name: 'test-proc', skillResourceId: null, status: 'running' }))

    // Mock run to throw an error
    const { run } = await import('../../run/index.js')
    const runMock = vi.mocked(run)
    runMock.mockImplementationOnce(async () => {
      throw new Error('Simulated run failure')
    })

    // Clear createWatchdog mock
    vi.mocked(createWatchdog).mockClear()

    // executeLoop catches run errors internally and returns { completed: false }
    const result = await executeLoop({ goal: 'Test goal', maxEpochs: 1, workspaceDir, git: false })

    expect(result.completed).toBe(false)

    // Assert createWatchdog was called once and stop() was called (finally block)
    expect(vi.mocked(createWatchdog)).toHaveBeenCalledOnce()
    const stopSpy = vi.mocked(createWatchdog).mock.results[0].value.stop
    expect(stopSpy).toHaveBeenCalledOnce()
  })

  it('completes via defense-in-depth when all PRD stories have passes=true but COMPLETE was not written', async () => {
    const processId = '00000000-0000-0000-0000-000000000088'
    const supabaseUrl = 'https://test.supabase.co'

    process.env.EVAL_PROCESS_ID = processId
    process.env.SUPABASE_URL = supabaseUrl
    process.env.SUPABASE_SERVICE_KEY = 'test-key'

    const fetchCalls: Array<{ url: string; method: string; body: string }> = []
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', mockFetch)

    const execFileSyncMock = vi.mocked(childProcess.execFileSync)
    execFileSyncMock.mockReturnValue(JSON.stringify({ name: 'test-proc', skillResourceId: null, status: 'running' }))

    // Mock run() to write state.json + PRD with all passes=true but NO COMPLETE signal
    const { run } = await import('../../run/index.js')
    const runMock = vi.mocked(run)
    runMock.mockImplementationOnce(async () => {
      writeFileSync(join(workspaceDir, 'state.json'), JSON.stringify({ active_prd: 'prd-001', epoch: 1 }))
      writeFileSync(join(workspaceDir, 'prd-001.json'), JSON.stringify({
        stories: [{ id: 1, passes: true }, { id: 2, passes: true }],
      }))
      // Intentionally do NOT write COMPLETE to progress.md
      return {
        sync: [],
        execution: {
          command: ['echo', 'mock'],
          output: { sessionId: 'mock-session-dind', success: true, rawOutput: '' },
          durationMs: 100,
          exitCode: 0,
        },
      }
    })

    const result = await executeLoop({ goal: 'Test goal defense-in-depth', maxEpochs: 3, workspaceDir, git: false })

    expect(result.completed).toBe(true)
    expect(result.epochs).toBe(1)

    // Defense-in-depth must have appended COMPLETE to progress.md
    const progressContent = readFileSync(join(workspaceDir, 'progress.md'), 'utf-8')
    expect(progressContent).toMatch(/\*\*COMPLETE\*\*/)

    // Must have called fetch to PATCH processes status to 'completed'
    const completedCall = fetchCalls.find(
      (c) => c.method === 'PATCH' && c.url.includes('processes') && c.url.includes(processId)
        && c.body.includes('"completed"'),
    )
    expect(completedCall).toBeDefined()
    const patchBody = JSON.parse(completedCall!.body)
    expect(patchBody.status).toBe('completed')
  })

  it('does not call createWatchdog() when EVAL_PROCESS_ID is not set', async () => {
    // EVAL_PROCESS_ID is already deleted by beforeEach
    // Also ensure EVAL_CAMPAIGN_ID is not set
    delete process.env.EVAL_CAMPAIGN_ID

    // Clear createWatchdog mock
    vi.mocked(createWatchdog).mockClear()

    const result = await executeLoop({ goal: 'Test goal', maxEpochs: 1, workspaceDir })

    expect(result.completed).toBe(false)

    // Assert createWatchdog was NOT called
    expect(vi.mocked(createWatchdog)).not.toHaveBeenCalled()
  })

  it('sets timeLimit:true (not epochLimitReached) when wall-clock time limit is reached', async () => {
    // Use a self-advancing mock: each call to Date.now() returns a value 25h larger than
    // the previous. This guarantees that wherever startTime is captured, the very next call
    // (the elapsed check in the loop) will show elapsed = 25h >= maxDuration (23h45m).
    const STEP = 25 * 60 * 60 * 1000 // 25 hours per call
    let nowValue = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowValue += STEP
      return nowValue
    })

    const result = await executeLoop({
      goal: 'Test goal time-limit',
      maxEpochs: 5,
      workspaceDir,
    })

    nowSpy.mockRestore()

    expect(result.completed).toBe(false)
    expect(result.timeLimit).toBe(true)
    expect(result.epochLimitReached).toBeUndefined()
    expect(result.sleeping).toBeUndefined()
  })
})
