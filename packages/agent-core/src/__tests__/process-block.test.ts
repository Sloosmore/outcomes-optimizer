import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'

const { fakeSpawn, fakeExecFileSync } = vi.hoisted(() => ({
  fakeSpawn: vi.fn(),
  fakeExecFileSync: vi.fn(),
}))
vi.mock('child_process', () => ({
  spawn: fakeSpawn,
  execFileSync: fakeExecFileSync,
}))

vi.mock('dotenv/config', () => ({}))

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://mock:mock@localhost/mock'
})

const fakeSql = Object.assign(vi.fn(), {
  json: (v: unknown) => v,
  end: vi.fn(),
  begin: vi.fn(),
})
vi.mock('postgres', () => ({
  default: vi.fn(() => fakeSql),
}))
vi.mock('@skill-networks/database/client', () => ({
  getSqlClient: () => fakeSql,
  closeSqlClient: vi.fn(),
}))

import { processCommand } from '../commands/process.js'
import { setAdapter, clearAdapter } from '../lib/adapter-factory.js'
import { PostgresOntologyAdapter } from '../adapters/postgres-ontology-adapter.js'

const UUID_PROC = 'aaaaaaaa-0000-0000-0000-000000000001'

describe('process block', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
    fakeSql.begin.mockReset()
    // Make sql.begin() invoke the callback with fakeSql as the transaction handle
    fakeSql.begin.mockImplementation(async (fn: (tx: typeof fakeSql) => Promise<unknown>) => fn(fakeSql))
    setAdapter(new PostgresOntologyAdapter())
    logs = []
    errors = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')))
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      const line = String(chunk)
      if (line.includes('[ERROR]') || line.includes('[WARN]')) errors.push(line)
      return true
    })
    process.exitCode = undefined
    delete process.env.EVAL_PROCESS_ID
    delete process.env.WORKTREE_PATH
  })

  afterEach(() => {
    clearAdapter()
    vi.restoreAllMocks()
  })

  it('happy path: blocks an active process', async () => {
    const proc = {
      id: UUID_PROC,
      name: 'my-proc',
      status: 'active',
      skill_resource_id: 'skill-1',
      worktree_path: null,
    }

    // 1. dbGetProcessById SELECT
    fakeSql.mockResolvedValueOnce([proc])
    // 2. dbBlockProcess UPDATE (primary via tryUpdateWithColumnFallback)
    fakeSql.mockResolvedValueOnce([{ id: UUID_PROC }])
    // 3. dbInsertAgentEvent INSERT
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['block', '--id', UUID_PROC, '--reason', 'no credentials'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(logs.join('\n')).toContain(`Process ${UUID_PROC} blocked`)
    expect(logs.join('\n')).toContain('no credentials')
  })

  it('stores reason in event payload', async () => {
    const proc = {
      id: UUID_PROC,
      name: 'my-proc',
      status: 'active',
      skill_resource_id: 'skill-1',
      worktree_path: null,
    }

    fakeSql.mockResolvedValueOnce([proc])
    fakeSql.mockResolvedValueOnce([{ id: UUID_PROC }])
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['block', '--id', UUID_PROC, '--reason', 'missing API key'], { from: 'user' })

    // The agent_events INSERT call (index 2) should contain 'process_blocked' source and reason payload
    const insertCall = fakeSql.mock.calls[2]
    const insertValues = insertCall.slice(1) as unknown[]
    expect(insertValues).toContain('process_blocked')
    const payload = insertValues[insertValues.length - 1] as Record<string, unknown>
    expect(payload).toMatchObject({ reason: 'missing API key' })
  })

  it('sets WORKTREE_PATH in the block update when env var is set', async () => {
    process.env.WORKTREE_PATH = '/tmp/my-worktree'
    const proc = {
      id: UUID_PROC,
      name: 'my-proc',
      status: 'active',
      skill_resource_id: 'skill-1',
      worktree_path: null,
    }

    fakeSql.mockResolvedValueOnce([proc])
    fakeSql.mockResolvedValueOnce([{ id: UUID_PROC }])
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['block', '--id', UUID_PROC, '--reason', 'needs manual setup'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    // The UPDATE call (index 1) should include worktree_path
    const updateCall = fakeSql.mock.calls[1]
    const updateValues = updateCall.slice(1) as unknown[]
    expect(updateValues).toContain('/tmp/my-worktree')
  })

  it('errors when process not found', async () => {
    // dbGetProcessById returns empty
    fakeSql.mockResolvedValueOnce([])

    const cmd = processCommand()
    await cmd.parseAsync(['block', '--id', UUID_PROC, '--reason', 'test'], { from: 'user' })

    expect(errors.join('\n')).toContain('Process not found')
    expect(process.exitCode).toBe(1)
    // No transaction was started
    expect(fakeSql.begin).not.toHaveBeenCalled()
  })

  it('errors when UPDATE matches zero rows (non-active process)', async () => {
    const proc = {
      id: UUID_PROC,
      name: 'my-proc',
      status: 'completed',
      skill_resource_id: 'skill-1',
      worktree_path: null,
    }

    // dbGetProcessById SELECT
    fakeSql.mockResolvedValueOnce([proc])
    // dbBlockProcess UPDATE returns empty (wrong status guard)
    fakeSql.mockResolvedValueOnce([])
    // diagnostic SELECT inside dbBlockProcess
    fakeSql.mockResolvedValueOnce([{ id: UUID_PROC, status: 'completed' }])

    const cmd = processCommand()
    await cmd.parseAsync(['block', '--id', UUID_PROC, '--reason', 'test'], { from: 'user' })

    expect(errors.join('\n')).toContain('completed')
    expect(errors.join('\n')).toContain('only active processes')
    expect(process.exitCode).toBe(1)
  })

  it('invalid UUID rejects without SQL calls', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['block', '--id', 'not-a-uuid', '--reason', 'test'], { from: 'user' })

    expect(errors.join('\n')).toContain('valid UUID')
    expect(process.exitCode).toBe(1)
    expect(fakeSql.mock.calls.length).toBe(0)
  })
})
