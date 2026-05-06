import type { execFileSync as realExecFileSync } from 'child_process'
import { stripAndPush, openPRAdapter } from '../open-pr.js'

type ExecCall = [string, readonly string[], { cwd: string; stdio: 'inherit' }]

function makeMockExec(throwOn?: string): {
  exec: typeof realExecFileSync
  calls: ExecCall[]
} {
  const calls: ExecCall[] = []
  const exec = vi.fn((cmd: string, args: readonly string[], opts: { cwd: string; stdio: 'inherit' }) => {
    if (throwOn && cmd === 'git' && args[0] === throwOn) {
      throw new Error(`mock ${throwOn} error`)
    }
    calls.push([cmd, args, opts])
    return Buffer.from('')
  }) as unknown as typeof realExecFileSync
  return { exec, calls }
}

const defaultOpts = {
  branch: 'feat/test-branch',
  worktreePath: '/tmp/worktree',
  title: 'My PR Title',
  body: 'My PR Body',
}

describe('stripAndPush', () => {
  it('(a) calls the exact 4-step sequence with correct args and cwd', () => {
    const { exec, calls } = makeMockExec()

    stripAndPush(defaultOpts, exec)

    expect(calls).toHaveLength(4)

    const expectedCwd = { cwd: '/tmp/worktree', stdio: 'inherit' }

    // 1. git rm
    expect(calls[0][0]).toBe('git')
    expect(calls[0][1]).toEqual(['rm', '-r', '--cached', 'workspace/'])
    expect(calls[0][2]).toEqual(expectedCwd)

    // 2. git commit
    expect(calls[1][0]).toBe('git')
    expect(calls[1][1]).toEqual(['commit', '-m', 'chore: strip workspace before PR'])
    expect(calls[1][2]).toEqual(expectedCwd)

    // 3. git push
    expect(calls[2][0]).toBe('git')
    expect(calls[2][1]).toEqual(['push', '--force-with-lease', 'origin', 'feat/test-branch'])
    expect(calls[2][2]).toEqual(expectedCwd)

    // 4. gh pr create
    expect(calls[3][0]).toBe('gh')
    expect(calls[3][1]).toEqual([
      'pr', 'create', '--draft', '--base', 'main', '--head', 'feat/test-branch',
      '--title', 'My PR Title', '--body', 'My PR Body',
    ])
    expect(calls[3][2]).toEqual(expectedCwd)
  })

  it('(b) continues when git rm throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { exec, calls } = makeMockExec('rm')

    stripAndPush(defaultOpts, exec)

    // git rm threw so it's not in calls; remaining 3 should be present
    expect(calls).toHaveLength(3)
    expect(calls[0][1][0]).toBe('commit')
    expect(calls[1][1][0]).toBe('push')
    expect(calls[2][0]).toBe('gh')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('git rm skipped'))

    warnSpy.mockRestore()
  })

  it('(c) continues when commit throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { exec, calls } = makeMockExec('commit')

    stripAndPush(defaultOpts, exec)

    // git rm succeeds, commit threw, push + pr create remain
    expect(calls).toHaveLength(3)
    expect(calls[0][1][0]).toBe('rm')
    expect(calls[1][1][0]).toBe('push')
    expect(calls[2][0]).toBe('gh')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('commit skipped'))

    warnSpy.mockRestore()
  })

  it('(d) propagates when push throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { exec } = makeMockExec('push')

    expect(() => stripAndPush(defaultOpts, exec)).toThrow('mock push error')

    warnSpy.mockRestore()
  })

  it('(e) uses default title and body when not provided', () => {
    const { exec, calls } = makeMockExec()
    const opts = { branch: 'feat/auto', worktreePath: '/tmp/wt' }

    stripAndPush(opts, exec)

    // pr create call is index 3
    expect(calls[3][1]).toEqual([
      'pr', 'create', '--draft', '--base', 'main', '--head', 'feat/auto',
      '--title', 'chore: feat/auto', '--body', '',
    ])
  })
})

describe('openPRAdapter', () => {
  it('(f) throws on empty branch', () => {
    expect(() => openPRAdapter({ branch: '', worktreePath: '/tmp' })).toThrow(
      'openPRAdapter: branch is required but was empty or not set',
    )
  })

  it('(g) throws on branch with unsafe characters', () => {
    expect(() => openPRAdapter({ branch: '--delete', worktreePath: '/tmp' })).toThrow(
      'openPRAdapter: branch contains unsafe characters',
    )
  })

  it('(h) throws on empty worktreePath', () => {
    expect(() => openPRAdapter({ branch: 'feat/valid', worktreePath: '' })).toThrow(
      'openPRAdapter: worktreePath is required but was empty or not set',
    )
  })

  it('(i) throws on relative worktreePath', () => {
    expect(() => openPRAdapter({ branch: 'feat/valid', worktreePath: 'relative/path' })).toThrow(
      'openPRAdapter: worktreePath must be an absolute path',
    )
  })
})
