/**
 * Unit tests for ProcessLifecycleAdapter.
 *
 * Verifies that each lifecycle method calls pnpm exec duoidal with the
 * correct subcommand and --id flag, using the processId set at construction —
 * no processId parameter on the methods themselves.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as childProcess from 'child_process'
import { ProcessLifecycleAdapter } from '../steps/process-lifecycle-adapter.js'

vi.mock('child_process')

describe('ProcessLifecycleAdapter', () => {
  const mockExecFileSync = vi.mocked(childProcess.execFileSync)
  const TEST_PROCESS_ID = 'deadbeef-1234-5678-abcd-ef0123456789'

  beforeEach(() => {
    mockExecFileSync.mockReturnValue('' as unknown as ReturnType<typeof childProcess.execFileSync>)
    // Stub env so tests are environment-agnostic: default CLI is 'pnpm exec duoidal'
    vi.stubEnv('SKILL_NETWORKS_CLI', 'pnpm exec duoidal')
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('stores processId at construction', () => {
    const adapter = new ProcessLifecycleAdapter(TEST_PROCESS_ID)
    expect(adapter.processId).toBe(TEST_PROCESS_ID)
  })

  it('throws when constructed with an invalid UUID', () => {
    expect(() => new ProcessLifecycleAdapter('not-a-uuid')).toThrow('Invalid processId: expected UUID')
  })

  it('onStarted() calls pnpm exec duoidal process active with --id', () => {
    const adapter = new ProcessLifecycleAdapter(TEST_PROCESS_ID)
    adapter.onStarted()

    expect(mockExecFileSync).toHaveBeenCalledOnce()
    const [cmd, args] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    expect(cmd).toBe('pnpm')
    expect(args).toContain('exec')
    expect(args).toContain('duoidal')
    expect(args).toContain('process')
    expect(args).toContain('active')
    expect(args).toContain('--id')
    expect(args).toContain(TEST_PROCESS_ID)
  })

  it('onCompleted() calls pnpm exec duoidal process complete with --id', () => {
    const adapter = new ProcessLifecycleAdapter(TEST_PROCESS_ID)
    adapter.onCompleted()

    expect(mockExecFileSync).toHaveBeenCalledOnce()
    const [cmd, args] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    expect(cmd).toBe('pnpm')
    expect(args).toContain('exec')
    expect(args).toContain('duoidal')
    expect(args).toContain('process')
    expect(args).toContain('complete')
    expect(args).toContain('--id')
    expect(args).toContain(TEST_PROCESS_ID)
  })

  it('onFailed(reason) calls pnpm exec duoidal process fail with --id and --reason', () => {
    const adapter = new ProcessLifecycleAdapter(TEST_PROCESS_ID)
    const reason = 'loop exited with code 1'
    adapter.onFailed(reason)

    expect(mockExecFileSync).toHaveBeenCalledOnce()
    const [cmd, args] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    expect(cmd).toBe('pnpm')
    expect(args).toContain('exec')
    expect(args).toContain('duoidal')
    expect(args).toContain('process')
    expect(args).toContain('fail')
    expect(args).toContain('--id')
    expect(args).toContain(TEST_PROCESS_ID)
    expect(args).toContain('--reason')
    expect(args).toContain(reason)
  })

  it('all methods use this.processId set at construction, not a method parameter', () => {
    const adapter = new ProcessLifecycleAdapter('cccccccc-cccc-cccc-cccc-cccccccccccc')

    adapter.onStarted()
    const [, argsStarted] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    const idIndexStarted = argsStarted.indexOf('--id')
    expect(argsStarted[idIndexStarted + 1]).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc')

    vi.clearAllMocks()
    adapter.onCompleted()
    const [, argsCompleted] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    const idIndexCompleted = argsCompleted.indexOf('--id')
    expect(argsCompleted[idIndexCompleted + 1]).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc')

    vi.clearAllMocks()
    adapter.onFailed('some reason')
    const [, argsFailed] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    const idIndexFailed = argsFailed.indexOf('--id')
    expect(argsFailed[idIndexFailed + 1]).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc')
  })

  it('execFileSync is called with stdio: inherit', () => {
    const adapter = new ProcessLifecycleAdapter(TEST_PROCESS_ID)
    adapter.onStarted()

    const [, , opts] = mockExecFileSync.mock.calls[0] as [string, string[], { stdio: string }]
    expect(opts).toMatchObject({ stdio: 'inherit' })
  })
})
