import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'

const { fakeSpawn } = vi.hoisted(() => ({
  fakeSpawn: vi.fn(),
}))
vi.mock('child_process', () => ({
  spawn: fakeSpawn,
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

const UUID_DEAD = 'aaaaaaaa-0000-0000-0000-000000000001'
const UUID_ROOT = 'bbbbbbbb-0000-0000-0000-000000000002'
const UUID_NEW = 'cccccccc-0000-0000-0000-000000000003'
const UUID_GOAL = 'dddddddd-0000-0000-0000-000000000004'
const UUID_SKILL = 'eeeeeeee-0000-0000-0000-000000000005'

describe('process restart', () => {
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
  })

  afterEach(() => {
    clearAdapter()
    vi.restoreAllMocks()
  })

  it('happy path: dead process has root_process_id set (inherits it)', async () => {
    const deadProcess = {
      id: UUID_DEAD,
      name: 'my-proc',
      status: 'failed',
      current_epoch: 3,
      root_process_id: UUID_ROOT,
      skill_resource_id: UUID_SKILL,
    }

    // 1. preflight dbGetProcessById SELECT (process.ts)
    fakeSql.mockResolvedValueOnce([deadProcess])
    // 2. internal dbGetProcessById SELECT (ProcessesService.restart)
    fakeSql.mockResolvedValueOnce([deadProcess])
    // 3. INSERT processes
    fakeSql.mockResolvedValueOnce([{ id: UUID_NEW }])
    // 4. first dbInsertAgentEvent (process_continued)
    fakeSql.mockResolvedValueOnce([{}])
    // 5. second dbInsertAgentEvent (process_born_from)
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    expect(logs.join('\n')).toContain(UUID_NEW)
    expect(process.exitCode).not.toBe(1)
  })

  it('happy path: dead process has root_process_id = null (null-coalesce: child root = dead.id)', async () => {
    const deadProcess = {
      id: UUID_DEAD,
      name: 'my-proc',
      status: 'completed',
      current_epoch: 2,
      root_process_id: null,
      skill_resource_id: UUID_SKILL,
    }

    // 1. preflight SELECT (process.ts)
    fakeSql.mockResolvedValueOnce([deadProcess])
    // 2. internal SELECT (ProcessesService.restart)
    fakeSql.mockResolvedValueOnce([deadProcess])
    // 3. INSERT processes
    fakeSql.mockResolvedValueOnce([{ id: UUID_NEW }])
    // 4. INSERT agent_events process_continued
    fakeSql.mockResolvedValueOnce([{}])
    // 5. INSERT agent_events process_born_from
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    expect(logs.join('\n')).toContain(UUID_NEW)
    expect(process.exitCode).not.toBe(1)

    // The INSERT call (index 2) should use dead.id as root_process_id
    // fakeSql is called as a tagged template: fakeSql(strings, ...values)
    // Values are: name, dead.id, rootProcessId (=dead.id since null), skill_resource_id
    const insertCall = fakeSql.mock.calls[2]
    const insertValues = insertCall.slice(1) as unknown[]
    // rootProcessId should be UUID_DEAD (same as dead.id)
    expect(insertValues).toContain(UUID_DEAD)
    // parent_process_id should also be UUID_DEAD
    const deadIdCount = insertValues.filter((v) => v === UUID_DEAD).length
    expect(deadIdCount).toBeGreaterThanOrEqual(2)
  })

  it('rejects status active', async () => {
    fakeSql.mockResolvedValueOnce([{
      id: UUID_DEAD,
      name: 'my-proc',
      status: 'active',
      current_epoch: 1,
      root_process_id: null,
      skill_resource_id: UUID_SKILL,
    }])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    expect(errors.join('\n')).toContain('active')
    expect(process.exitCode).toBe(1)
    // Only one SQL call (the SELECT), no INSERT
    expect(fakeSql.mock.calls.length).toBe(1)
  })

  it('rejects status pending', async () => {
    fakeSql.mockResolvedValueOnce([{
      id: UUID_DEAD,
      name: 'my-proc',
      status: 'pending',
      current_epoch: 0,
      root_process_id: null,
      skill_resource_id: UUID_SKILL,
    }])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    expect(errors.join('\n')).toContain('pending')
    expect(process.exitCode).toBe(1)
    expect(fakeSql.mock.calls.length).toBe(1)
  })

  it('rejects status waiting', async () => {
    fakeSql.mockResolvedValueOnce([{
      id: UUID_DEAD,
      name: 'my-proc',
      status: 'waiting',
      current_epoch: 0,
      root_process_id: null,
      skill_resource_id: UUID_SKILL,
    }])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    expect(errors.join('\n')).toContain('waiting')
    expect(process.exitCode).toBe(1)
    expect(fakeSql.mock.calls.length).toBe(1)
  })

  it('rejects status queued', async () => {
    fakeSql.mockResolvedValueOnce([{
      id: UUID_DEAD,
      name: 'my-proc',
      status: 'queued',
      current_epoch: 0,
      root_process_id: null,
      skill_resource_id: UUID_SKILL,
    }])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    expect(errors.join('\n')).toContain('queued')
    expect(process.exitCode).toBe(1)
    expect(fakeSql.mock.calls.length).toBe(1)
  })

  it('process_continued event payload has new_process_id', async () => {
    const deadProcess = {
      id: UUID_DEAD,
      name: 'my-proc',
      status: 'failed',
      current_epoch: 5,
      root_process_id: UUID_ROOT,
      skill_resource_id: UUID_SKILL,
    }

    // 1. preflight SELECT (process.ts)
    fakeSql.mockResolvedValueOnce([deadProcess])
    // 2. internal SELECT (ProcessesService.restart)
    fakeSql.mockResolvedValueOnce([deadProcess])
    // 3. INSERT processes
    fakeSql.mockResolvedValueOnce([{ id: UUID_NEW }])
    // 4. INSERT agent_events process_continued
    fakeSql.mockResolvedValueOnce([{}])
    // 5. INSERT agent_events process_born_from
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    // Call index 3 is the process_continued INSERT to agent_events
    // Tagged template: fakeSql(strings, processId, processName, resourceId, source, payload)
    const continuedCall = fakeSql.mock.calls[3]
    const continuedValues = continuedCall.slice(1) as unknown[]
    // source = 'process_continued' is one of the values
    expect(continuedValues).toContain('process_continued')
    // payload is the last value: { new_process_id: UUID_NEW }
    const payload = continuedValues[continuedValues.length - 1] as Record<string, unknown>
    expect(payload).toMatchObject({ new_process_id: UUID_NEW })
  })

  it('process_born_from event payload has dead_process_id and epoch_number', async () => {
    const deadProcess = {
      id: UUID_DEAD,
      name: 'my-proc',
      status: 'failed',
      current_epoch: 7,
      root_process_id: UUID_ROOT,
      skill_resource_id: UUID_SKILL,
    }

    // 1. preflight SELECT (process.ts)
    fakeSql.mockResolvedValueOnce([deadProcess])
    // 2. internal SELECT (ProcessesService.restart)
    fakeSql.mockResolvedValueOnce([deadProcess])
    // 3. INSERT processes
    fakeSql.mockResolvedValueOnce([{ id: UUID_NEW }])
    // 4. INSERT agent_events process_continued
    fakeSql.mockResolvedValueOnce([{}])
    // 5. INSERT agent_events process_born_from
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    // Call index 4 is the process_born_from INSERT to agent_events
    const bornFromCall = fakeSql.mock.calls[4]
    const bornFromValues = bornFromCall.slice(1) as unknown[]
    expect(bornFromValues).toContain('process_born_from')
    const payload = bornFromValues[bornFromValues.length - 1] as Record<string, unknown>
    expect(payload).toMatchObject({
      dead_process_id: UUID_DEAD,
      epoch_number: '7',
    })
  })

  it('process not found: SELECT returns empty array', async () => {
    fakeSql.mockResolvedValueOnce([])

    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', UUID_DEAD], { from: 'user' })

    expect(errors.join('\n')).toContain('Process not found')
    expect(process.exitCode).toBe(1)
  })

  it('invalid UUID rejects without SQL calls', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['restart', '--id', 'not-a-uuid'], { from: 'user' })

    expect(errors.join('\n')).toContain('valid UUID')
    expect(process.exitCode).toBe(1)
    expect(fakeSql.mock.calls.length).toBe(0)
  })
})
