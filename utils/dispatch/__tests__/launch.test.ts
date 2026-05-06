/**
 * Regression tests for launch.ts script generation.
 *
 * Verifies the shell script built by launch() does not contain single-quoted
 * paths inside NODE_OPTIONS. Prior bug: shellEscape() wrapped the interceptor
 * boot path in single quotes, which became literal characters inside the
 * double-quoted bash string, causing Node.js to fail with ERR_MODULE_NOT_FOUND.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as childProcess from 'child_process'
import { launch } from '../steps/launch.js'

vi.mock('child_process')

describe('launch()', () => {
  const mockExecFileSync = vi.mocked(childProcess.execFileSync)
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    mockExecFileSync.mockReturnValue('' as unknown as ReturnType<typeof childProcess.execFileSync>)
    savedEnv['EVAL_PROCESS_ID'] = process.env.EVAL_PROCESS_ID
    delete process.env.EVAL_PROCESS_ID
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (savedEnv['EVAL_PROCESS_ID'] !== undefined) {
      process.env.EVAL_PROCESS_ID = savedEnv['EVAL_PROCESS_ID']
    } else {
      delete process.env.EVAL_PROCESS_ID
    }
  })

  it('generates NODE_OPTIONS without single quotes around the boot path', async () => {
    await launch({
      slug: 'test-slug',
      worktreePath: '/root/dispatch/3fdfd8ec',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })

    expect(mockExecFileSync).toHaveBeenCalledOnce()
    const [, args] = mockExecFileSync.mock.calls[0]
    // tmux passes the script as the last arg to bash -c
    const script = (args as string[]).at(-1) ?? ''

    // Must not have single-quoted path in NODE_OPTIONS
    expect(script).not.toContain(
      `NODE_OPTIONS="--import '/root/dispatch/3fdfd8ec/services/credential-proxy/interceptor-boot.mjs'"`,
    )

    // Must have the raw path without extra quoting
    expect(script).toContain(
      `NODE_OPTIONS="--import /root/dispatch/3fdfd8ec/services/credential-proxy/interceptor-boot.mjs"`,
    )
  })

  it('starts a tmux session with the correct slug', async () => {
    await launch({
      slug: 'my-goal',
      worktreePath: '/root/dispatch/abcd1234',
      processId: '11111111-2222-3333-4444-555555555555',
    })

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session', '-d', '-s', 'my-goal']),
      expect.anything(),
    )
  })

  it('injects EVAL_PROCESS_ID into the script', async () => {
    const processId = 'ffffffff-0000-1111-2222-333333333333'
    await launch({
      slug: 'test',
      worktreePath: '/root/dispatch/test',
      processId,
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    expect(script).toContain(`EVAL_PROCESS_ID='${processId}'`)
  })

  it('includes --max-epochs flag when provided', async () => {
    await launch({
      slug: 'test',
      worktreePath: '/root/dispatch/test',
      processId: 'ffffffff-0000-1111-2222-333333333333',
      maxEpochs: 5,
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    expect(script).toContain('--max-epochs 5')
  })

  it('teardown call appears after the closing fi', async () => {
    await launch({
      slug: 'test-slug',
      worktreePath: '/root/dispatch/3fdfd8ec',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    expect(script).toContain('utils/dispatch/teardown.ts')
    const fiIndex = script.lastIndexOf('\nfi\n')
    // Use lastIndexOf — the compose lifecycle refactor added earlier teardown.ts
    // calls inside the sleeping/blocked branches. We want the final post-loop teardown.
    const teardownIndex = script.lastIndexOf('utils/dispatch/teardown.ts')
    expect(fiIndex).toBeGreaterThan(-1)
    expect(teardownIndex).toBeGreaterThan(fiIndex)
  })

  it('forwards ANTHROPIC_BASE_URL when set', async () => {
    const savedUrl = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com/v1'
    try {
      await launch({ slug: 'test', worktreePath: '/root/dispatch/test', processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
      const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
      expect(script).toContain("export ANTHROPIC_BASE_URL='https://proxy.example.com/v1'")
    } finally {
      if (savedUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = savedUrl
    }
  })

  it('omits ANTHROPIC_BASE_URL when not set', async () => {
    const savedUrl = process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_BASE_URL
    try {
      await launch({ slug: 'test', worktreePath: '/root/dispatch/test', processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
      const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
      expect(script).not.toContain('ANTHROPIC_BASE_URL')
    } finally {
      if (savedUrl !== undefined) process.env.ANTHROPIC_BASE_URL = savedUrl
    }
  })

  it('forwards ANTHROPIC_API_KEY when set', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
    try {
      await launch({ slug: 'test', worktreePath: '/root/dispatch/test', processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
      const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
      expect(script).toContain("export ANTHROPIC_API_KEY='sk-ant-test-key'")
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = savedKey
    }
  })

  it('omits ANTHROPIC_API_KEY when not set', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await launch({ slug: 'test', worktreePath: '/root/dispatch/test', processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
      const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
      expect(script).not.toContain('ANTHROPIC_API_KEY')
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
    }
  })

  it('shell-escapes ANTHROPIC_BASE_URL containing special characters', async () => {
    const savedUrl = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = "https://example.com/path?foo=bar&baz=qux"
    try {
      await launch({ slug: 'test', worktreePath: '/root/dispatch/test', processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
      const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
      // Value must be single-quoted so shell metacharacters are not interpreted
      expect(script).toContain("export ANTHROPIC_BASE_URL='https://example.com/path?foo=bar&baz=qux'")
    } finally {
      if (savedUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = savedUrl
    }
  })

  it('teardown call includes --slug and --worktree args', async () => {
    await launch({
      slug: 'test-slug',
      worktreePath: '/root/dispatch/3fdfd8ec',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    const teardownLineStart = script.indexOf('utils/dispatch/teardown.ts')
    const teardownLineEnd = script.indexOf('\n', teardownLineStart)
    const teardownLine = script.slice(teardownLineStart, teardownLineEnd === -1 ? undefined : teardownLineEnd)
    expect(teardownLine).toContain("--slug 'test-slug'")
    expect(teardownLine).toContain("--worktree '/root/dispatch/3fdfd8ec'")
  })

  it('post-loop teardown includes compose and worktree provisions', async () => {
    await launch({
      slug: 'test-slug',
      worktreePath: '/root/dispatch/3fdfd8ec',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    // Find the final teardown call (after the closing fi)
    const fiIndex = script.lastIndexOf('\nfi\n')
    const postLoopTeardown = script.slice(fiIndex)
    expect(postLoopTeardown).toContain('--provision compose')
    expect(postLoopTeardown).toContain('--provision worktree')
    // Dead provisioners removed in commit 968d0da10 must never reappear
    expect(postLoopTeardown).not.toContain('--provision credential-proxy')
    expect(postLoopTeardown).not.toContain('--provision supabase-branch')
  })

  it('throws when processId is empty', async () => {
    await expect(
      launch({
        slug: 'test',
        worktreePath: '/root/dispatch/test',
        processId: '',
      }),
    ).rejects.toThrow('processId is required')
  })

  it('throws when processId is undefined', async () => {
    await expect(
      launch({
        slug: 'test',
        worktreePath: '/root/dispatch/test',
        processId: undefined as unknown as string,
      }),
    ).rejects.toThrow('processId is required')
  })

  it('throws when processId is not a valid UUID', async () => {
    await expect(
      launch({
        slug: 'test',
        worktreePath: '/root/dispatch/test',
        processId: 'not-a-uuid',
      }),
    ).rejects.toThrow('Invalid processId: expected UUID')
  })

  it('injects EVAL_SKILL_RESOURCE_ID when skillResourceId is provided', async () => {
    const skillResourceId = 'cccccccc-dddd-eeee-ffff-000000000000'
    await launch({
      slug: 'test',
      worktreePath: '/root/dispatch/test',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      skillResourceId,
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    expect(script).toContain(`EVAL_SKILL_RESOURCE_ID='${skillResourceId}'`)
  })

  it('omits EVAL_SKILL_RESOURCE_ID when skillResourceId is not provided', async () => {
    await launch({
      slug: 'test',
      worktreePath: '/root/dispatch/test',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    expect(script).not.toContain('EVAL_SKILL_RESOURCE_ID')
  })

  it('throws when skillResourceId is not a valid UUID', async () => {
    await expect(
      launch({
        slug: 'test',
        worktreePath: '/root/dispatch/test',
        processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        skillResourceId: 'not-a-uuid',
      }),
    ).rejects.toThrow('Invalid skillResourceId: expected UUID')
  })

  it('writes .loop-pid with EXIT trap and safe permissions', async () => {
    await launch({
      slug: 'test',
      worktreePath: '/root/dispatch/test',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    expect(script).toContain("trap 'rm -f workspace/.loop-pid' EXIT")
    // umask 077 ensures the pid file is created with 600 permissions atomically (no race)
    expect(script).toContain('( umask 077 && echo $$ > workspace/.loop-pid )')
  })

  it('process active runs in background and wait precedes complete/fail transitions', async () => {
    await launch({
      slug: 'test',
      worktreePath: '/root/dispatch/test',
      processId: 'ffffffff-0000-1111-2222-333333333333',
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''

    // Background launch: active must use & so the loop starts immediately
    expect(script).toContain('process active --id "$EVAL_PROCESS_ID" & ACTIVE_PID=$!')

    // Wait must appear so complete/fail see the post-active DB state
    expect(script).toContain('wait $ACTIVE_PID')

    // Ordering: wait must come before PROC_STATUS query and complete/fail transitions.
    // PROC_STATUS must read the post-active DB state, so it must follow wait.
    const waitIdx = script.indexOf('wait $ACTIVE_PID')
    const procStatusIdx = script.indexOf('PROC_STATUS=')
    const completeIdx = script.indexOf('process complete')
    const failIdx = script.indexOf('process fail')
    expect(waitIdx).toBeGreaterThan(-1)
    expect(procStatusIdx).toBeGreaterThan(waitIdx)
    expect(completeIdx).toBeGreaterThan(waitIdx)
    expect(failIdx).toBeGreaterThan(waitIdx)
  })

  it('tmux script uses process-lifecycle-adapter instead of agent-core process active/complete/fail', async () => {
    await launch({
      slug: 'test',
      worktreePath: '/root/dispatch/test',
      processId: 'ffffffff-0000-1111-2222-333333333333',
    })

    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''

    // Must NOT contain inline agent-core lifecycle calls (hardcoded binary)
    expect(script).not.toContain('agent-core process active')
    expect(script).not.toContain('agent-core process complete')
    expect(script).not.toContain('agent-core process fail')

    // Must use $SKILL_NETWORKS_CLI variable for all lifecycle transitions so the
    // binary is swappable without rebuilding bundles (duoidal, agent-core, or adapter).
    expect(script).toContain('$SKILL_NETWORKS_CLI process active')
    expect(script).toContain('$SKILL_NETWORKS_CLI process complete')
    expect(script).toContain('$SKILL_NETWORKS_CLI process fail')
  })

  it('waiting branch exits before teardown (worktree preserved)', async () => {
    await launch({
      slug: 'test-slug',
      worktreePath: '/root/dispatch/3fdfd8ec',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    // Find the waiting branch
    const waitingMatch = script.indexOf('PROC_STATUS" = "waiting"')
    expect(waitingMatch).toBeGreaterThan(-1)
    // Find exit 0 after the waiting branch start
    const exitIndex = script.indexOf('exit 0', waitingMatch)
    // Find the FINAL teardown invocation (post-loop full cleanup).
    // Compose lifecycle refactor added earlier teardown.ts calls inside the
    // waiting/blocked branches for compose-only cleanup.
    const teardownIndex = script.lastIndexOf('utils/dispatch/teardown.ts')
    // exit 0 must come BEFORE the final teardown
    expect(exitIndex).toBeGreaterThan(-1)
    expect(teardownIndex).toBeGreaterThan(exitIndex)
  })

  it('blocked branch exits before teardown (worktree preserved)', async () => {
    await launch({
      slug: 'test-slug',
      worktreePath: '/root/dispatch/3fdfd8ec',
      processId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
    const script = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1) ?? ''
    const blockedMatch = script.indexOf('PROC_STATUS" = "blocked"')
    expect(blockedMatch).toBeGreaterThan(-1)
    const exitAfterBlocked = script.indexOf('exit 0', blockedMatch)
    // Use lastIndexOf to find the FINAL post-loop teardown — the compose lifecycle
    // refactor added earlier teardown.ts calls inside the blocked branch for compose cleanup.
    const teardownIndex = script.lastIndexOf('utils/dispatch/teardown.ts')
    expect(exitAfterBlocked).toBeGreaterThan(-1)
    expect(teardownIndex).toBeGreaterThan(exitAfterBlocked)
  })

})
