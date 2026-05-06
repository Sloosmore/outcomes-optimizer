import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

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

// Mock open-pr adapter before importing executeLoop
vi.mock('../adapters/open-pr', () => ({
  openPRAdapter: vi.fn(),
}))

// Mock the run module — will be overridden per-test when needed
vi.mock('../../run', () => ({
  run: vi.fn(),
}))

// Allow tests to control execFileSync for checkWaitingStatus
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), execSync: actual.execSync }
})

import { executeLoop } from '../index.js'
import { openPRAdapter } from '../adapters/open-pr.js'
import { run } from '../../run/index.js'

describe('openPRAdapter wiring in executeLoop', () => {
  const testDir = join(tmpdir(), 'ralph-loop-pr-test')
  const workspaceDir = join(testDir, 'workspace')

  let savedProcessId: string | undefined
  let savedCampaignId: string | undefined
  let savedEvalBranch: string | undefined

  const makeRunResult = () => ({
    sync: [],
    execution: {
      command: ['echo', 'mock'],
      output: {
        sessionId: 'mock-session-1',
        success: true,
        rawOutput: 'mock output',
      },
      durationMs: 100,
      exitCode: 0,
    },
  })

  beforeEach(() => {
    mkdirSync(workspaceDir, { recursive: true })
    savedProcessId = process.env.EVAL_PROCESS_ID
    savedCampaignId = process.env.EVAL_CAMPAIGN_ID
    savedEvalBranch = process.env.EVAL_BRANCH
    delete process.env.EVAL_PROCESS_ID
    delete process.env.EVAL_CAMPAIGN_ID
    delete process.env.EVAL_BRANCH
    vi.mocked(openPRAdapter).mockClear()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    if (savedProcessId !== undefined) process.env.EVAL_PROCESS_ID = savedProcessId
    else delete process.env.EVAL_PROCESS_ID
    if (savedCampaignId !== undefined) process.env.EVAL_CAMPAIGN_ID = savedCampaignId
    else delete process.env.EVAL_CAMPAIGN_ID
    if (savedEvalBranch !== undefined) process.env.EVAL_BRANCH = savedEvalBranch
    else delete process.env.EVAL_BRANCH
  })

  it('calls openPRAdapter once with correct args when COMPLETE signal and EVAL_BRANCH are set', async () => {
    const testBranch = 'boot/test-branch-abc123'
    process.env.EVAL_BRANCH = testBranch
    const progressFile = join(workspaceDir, 'progress.md')

    // run() writes COMPLETE to progress.md so the post-run check triggers openPRAdapter
    vi.mocked(run).mockImplementationOnce(async () => {
      writeFileSync(progressFile, 'COMPLETE\n\nAll done!')
      return makeRunResult()
    })

    await executeLoop({
      goal: 'test',
      maxEpochs: 1,
      workspaceDir,
      git: false,
      pr: true,
    })

    expect(vi.mocked(openPRAdapter)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(openPRAdapter)).toHaveBeenCalledWith({
      branch: testBranch,
      worktreePath: resolve(workspaceDir, '..'),
    })
  })

  it('does not call openPRAdapter when pr flag is false', async () => {
    const testBranch = 'boot/test-branch-abc123'
    process.env.EVAL_BRANCH = testBranch
    const progressFile = join(workspaceDir, 'progress.md')

    vi.mocked(run).mockImplementationOnce(async () => {
      writeFileSync(progressFile, 'COMPLETE\n\nAll done!')
      return makeRunResult()
    })

    await executeLoop({
      goal: 'test',
      maxEpochs: 1,
      workspaceDir,
      git: false,
      pr: false,
    })

    expect(vi.mocked(openPRAdapter)).not.toHaveBeenCalled()
  })

  it('does not call openPRAdapter when EVAL_BRANCH is not set', async () => {
    // EVAL_BRANCH is already deleted in beforeEach
    const progressFile = join(workspaceDir, 'progress.md')

    vi.mocked(run).mockImplementationOnce(async () => {
      writeFileSync(progressFile, 'COMPLETE\n\nAll done!')
      return makeRunResult()
    })

    await executeLoop({
      goal: 'test',
      maxEpochs: 1,
      workspaceDir,
      git: false,
      pr: true,
    })

    expect(vi.mocked(openPRAdapter)).not.toHaveBeenCalled()
  })
})
