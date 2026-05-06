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

const { fakeExistsSync, fakeReadFileSync, fakeWriteFileSync } = vi.hoisted(() => ({
  fakeExistsSync: vi.fn(),
  fakeReadFileSync: vi.fn(),
  fakeWriteFileSync: vi.fn(),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: fakeExistsSync,
    readFileSync: fakeReadFileSync,
    writeFileSync: fakeWriteFileSync,
  }
})

import { processCommand } from '../commands/process.js'
import { setAdapter, clearAdapter } from '../lib/adapter-factory.js'
import { PostgresOntologyAdapter } from '../adapters/postgres-ontology-adapter.js'

const UUID_PROC = 'aaaaaaaa-0000-0000-0000-000000000001'
const UUID_SKILL = 'eeeeeeee-0000-0000-0000-000000000005'

const WORKTREE_PATH = '/fake/worktree'
const GOAL_FILE_PATH = `${WORKTREE_PATH}/workspace/goal.md`

const BEFORE_CONTENT = '# Goal\nDo the thing.'
const APPEND_TEXT = 'Also do the other thing.'
const AFTER_CONTENT = BEFORE_CONTENT + '\n' + APPEND_TEXT

function makeProcess(overrides: Partial<{
  skill_resource_id: string | null
  worktree_path: string | null
}> = {}) {
  return {
    id: UUID_PROC,
    name: 'my-proc',
    status: 'active',
    current_epoch: 2,
    root_process_id: null,
    skill_resource_id: UUID_SKILL,
    worktree_path: WORKTREE_PATH,
    ...overrides,
  }
}

describe('process amend', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
    setAdapter(new PostgresOntologyAdapter())
    fakeExistsSync.mockReset()
    fakeReadFileSync.mockReset()
    fakeWriteFileSync.mockReset()
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

    // Default: worktree exists, goal.md readable
    fakeExistsSync.mockReturnValue(true)
    fakeReadFileSync.mockReturnValue(BEFORE_CONTENT)
    fakeWriteFileSync.mockImplementation(() => undefined)
  })

  afterEach(() => {
    clearAdapter()
    vi.restoreAllMocks()
  })

  it('happy path: appends text, updates DB resource, inserts goal_amended event', async () => {
    // Call 0: dbGetProcessById SELECT
    fakeSql.mockResolvedValueOnce([makeProcess()])
    // Call 1: UPDATE resources
    fakeSql.mockResolvedValueOnce([{}])
    // Call 2: dbInsertAgentEvent INSERT agent_events
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['amend', '--id', UUID_PROC, '--append', APPEND_TEXT], { from: 'user' })

    expect(process.exitCode).not.toBe(1)

    // FS write happened with appended content
    expect(fakeWriteFileSync).toHaveBeenCalledWith(GOAL_FILE_PATH, AFTER_CONTENT, 'utf-8')

    // SQL UPDATE resources happened (call index 1)
    expect(fakeSql.mock.calls.length).toBeGreaterThanOrEqual(2)
    const updateCall = fakeSql.mock.calls[1]
    const updateValues = updateCall.slice(1) as unknown[]
    expect(updateValues).toContain(AFTER_CONTENT)
    expect(updateValues).toContain(UUID_SKILL)

    // agent_events INSERT happened (call index 2) with source='goal_amended'
    const eventCall = fakeSql.mock.calls[2]
    const eventValues = eventCall.slice(1) as unknown[]
    expect(eventValues).toContain('goal_amended')
    const payload = eventValues[eventValues.length - 1] as Record<string, unknown>
    expect(payload).toMatchObject({ before: BEFORE_CONTENT, after: AFTER_CONTENT })
  })

  it('null skill_resource_id: exits 1, error references skill_resource_id, no FS write, no SQL beyond SELECT', async () => {
    fakeSql.mockResolvedValueOnce([makeProcess({ skill_resource_id: null })])

    const cmd = processCommand()
    await cmd.parseAsync(['amend', '--id', UUID_PROC, '--append', APPEND_TEXT], { from: 'user' })

    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toMatch(/skill_resource_id/)
    expect(fakeWriteFileSync).not.toHaveBeenCalled()
    // Only the SELECT call, nothing after
    expect(fakeSql.mock.calls.length).toBe(1)
  })

  it('null worktree_path: exits 1, no FS write', async () => {
    fakeSql.mockResolvedValueOnce([makeProcess({ worktree_path: null })])

    const cmd = processCommand()
    await cmd.parseAsync(['amend', '--id', UUID_PROC, '--append', APPEND_TEXT], { from: 'user' })

    expect(process.exitCode).toBe(1)
    expect(fakeWriteFileSync).not.toHaveBeenCalled()
  })

  it('worktree_path does not exist on disk: exits 1, no FS write', async () => {
    fakeExistsSync.mockReturnValue(false)
    fakeSql.mockResolvedValueOnce([makeProcess()])

    const cmd = processCommand()
    await cmd.parseAsync(['amend', '--id', UUID_PROC, '--append', APPEND_TEXT], { from: 'user' })

    expect(process.exitCode).toBe(1)
    expect(fakeWriteFileSync).not.toHaveBeenCalled()
  })

  it('DB UPDATE failure: FS write happened, agent_events INSERT not called, exits 1', async () => {
    fakeSql.mockResolvedValueOnce([makeProcess()])
    fakeSql.mockRejectedValueOnce(new Error('DB update failed'))

    const cmd = processCommand()
    await cmd.parseAsync(['amend', '--id', UUID_PROC, '--append', APPEND_TEXT], { from: 'user' })

    expect(process.exitCode).toBe(1)

    // FS write DID happen (before DB)
    expect(fakeWriteFileSync).toHaveBeenCalledWith(GOAL_FILE_PATH, AFTER_CONTENT, 'utf-8')

    // agent_events INSERT was NOT called (only SELECT + failed UPDATE)
    expect(fakeSql.mock.calls.length).toBe(2)
  })

  it('goal_amended payload shape: before is original content, after is before + newline + appendText', async () => {
    fakeSql.mockResolvedValueOnce([makeProcess()])
    fakeSql.mockResolvedValueOnce([{}])
    fakeSql.mockResolvedValueOnce([{}])

    const cmd = processCommand()
    await cmd.parseAsync(['amend', '--id', UUID_PROC, '--append', APPEND_TEXT], { from: 'user' })

    const eventCall = fakeSql.mock.calls[2]
    const eventValues = eventCall.slice(1) as unknown[]
    const payload = eventValues[eventValues.length - 1] as Record<string, unknown>

    expect(payload.before).toBe(BEFORE_CONTENT)
    expect(payload.after).toBe(BEFORE_CONTENT + '\n' + APPEND_TEXT)
  })
})
