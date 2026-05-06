import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('dotenv/config', () => ({}))

const fakeSql = Object.assign(vi.fn(), { json: (v: unknown) => v })
vi.mock('@skill-networks/database/client', () => ({
  getSqlClient: () => fakeSql,
  closeSqlClient: vi.fn()
}))

import { InMemoryOntologyAdapter } from '../adapters/in-memory-ontology-adapter.js'
import { PostgresOntologyAdapter } from '../adapters/postgres-ontology-adapter.js'
import { setAdapter, clearAdapter } from '../lib/adapter-factory.js'
import { cronCommand } from '../commands/cron.js'
import { OntologyError, OntologyErrorCode } from '../lib/ontology-error.js'

function makeAdapter(): InMemoryOntologyAdapter {
  const adapter = new InMemoryOntologyAdapter()
  adapter.seedResourceType({ name: 'cron', finite: false, description: 'Cron schedule' })
  adapter.seedResourceType({ name: 'skill', finite: false, description: 'Skill' })
  adapter.seedResourceType({ name: 'credential', finite: false, description: 'Credential' })
  adapter.seedLinkType({ name: 'schedules', description: 'Cron schedules a skill', cardinality: 'many-to-one', created_at: new Date().toISOString() })
  adapter.seedLinkTypeRule({ id: 'rule-1', link_type: 'schedules', from_type: 'cron', to_type: 'skill', created_at: new Date().toISOString() })
  return adapter
}

// ─── Rejection paths (R20–R27) — 8 test cases using InMemoryOntologyAdapter ──

describe('cron command — rejection paths', () => {
  let logs: string[]
  let errors: string[]
  let adapter: InMemoryOntologyAdapter

  beforeEach(() => {
    adapter = makeAdapter()
    setAdapter(adapter)
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

  // R20: Invalid cron expression — wrong part count
  it('R20: rejects cron expression with 4 parts (not 5)', async () => {
    await adapter.addResource('my-skill', 'skill', {})
    const cmd = cronCommand()
    await cmd.parseAsync(['create', '--name', 'c', '--schedule', '0 3 * *', '--skill', 'my-skill', '--prompt', 'x'], { from: 'user' })
    expect(errors.join('\n')).toMatch(/invalid/i)
    expect(process.exitCode).toBe(1)
  })

  // R21: Invalid cron expression — out-of-range minute value
  it('R21: rejects cron expression with minute > 59', async () => {
    await adapter.addResource('my-skill', 'skill', {})
    const cmd = cronCommand()
    await cmd.parseAsync(['create', '--name', 'c', '--schedule', '99 3 * * *', '--skill', 'my-skill', '--prompt', 'x'], { from: 'user' })
    expect(errors.join('\n')).toMatch(/invalid/i)
    expect(process.exitCode).toBe(1)
  })

  // R22: Non-existent skill name
  it('R22: rejects non-existent skill name with "skill resource not found"', async () => {
    const cmd = cronCommand()
    await cmd.parseAsync(['create', '--name', 'c', '--schedule', '0 3 * * *', '--skill', 'does-not-exist', '--prompt', 'x'], { from: 'user' })
    expect(errors.join('\n')).toContain('skill resource not found')
    expect(process.exitCode).toBe(1)
  })

  // R23: Non-skill resource type as skill
  it('R23: rejects non-skill resource type with "must be type skill"', async () => {
    await adapter.addResource('my-cred', 'credential', {})
    const cmd = cronCommand()
    await cmd.parseAsync(['create', '--name', 'c', '--schedule', '0 3 * * *', '--skill', 'my-cred', '--prompt', 'x'], { from: 'user' })
    expect(errors.join('\n')).toContain('must be type skill')
    expect(process.exitCode).toBe(1)
  })

  // R24: Duplicate cron name
  it('R24: rejects duplicate cron name with "already exists"', async () => {
    await adapter.addResource('my-skill', 'skill', {})
    const cmd1 = cronCommand()
    await cmd1.parseAsync(['create', '--name', 'dup-cron', '--schedule', '0 3 * * *', '--skill', 'my-skill', '--prompt', 'x'], { from: 'user' })
    logs = []
    errors = []
    process.exitCode = undefined
    const cmd2 = cronCommand()
    await cmd2.parseAsync(['create', '--name', 'dup-cron', '--schedule', '0 4 * * *', '--skill', 'my-skill', '--prompt', 'y'], { from: 'user' })
    expect(errors.join('\n')).toContain('already exists')
    expect(process.exitCode).toBe(1)
  })

  // R25: disable on non-existent name
  it('R25: cron disable on non-existent name exits 1', async () => {
    const cmd = cronCommand()
    await cmd.parseAsync(['disable', '--name', 'ghost-cron'], { from: 'user' })
    expect(process.exitCode).toBe(1)
  })

  // R26: enable on non-existent name
  it('R26: cron enable on non-existent name exits 1', async () => {
    const cmd = cronCommand()
    await cmd.parseAsync(['enable', '--name', 'ghost-cron'], { from: 'user' })
    expect(process.exitCode).toBe(1)
  })

  // R27: remove on non-existent name
  it('R27: cron remove on non-existent name exits 1', async () => {
    const cmd = cronCommand()
    await cmd.parseAsync(['remove', '--name', 'ghost-cron'], { from: 'user' })
    expect(process.exitCode).toBe(1)
  })
})

// ─── AdapterErrorParity — both adapters throw identical OntologyError codes ──

describe('AdapterErrorParity', () => {
  const pgAdapter = new PostgresOntologyAdapter()

  beforeEach(() => {
    fakeSql.mockReset()
  })

  it('DUPLICATE_RESOURCE: addResource throws same .code from both adapters', async () => {
    const inMemory = makeAdapter()
    await inMemory.addResource('dup', 'skill', {})

    const inMemErr = await inMemory.addResource('dup', 'skill', {}).catch(e => e)
    expect(inMemErr).toBeInstanceOf(OntologyError)
    expect((inMemErr as OntologyError).code).toBe(OntologyErrorCode.DUPLICATE_RESOURCE)

    fakeSql.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))
    const pgErr = await pgAdapter.addResource('dup', 'skill', {}).catch(e => e)
    expect(pgErr).toBeInstanceOf(OntologyError)
    expect((pgErr as OntologyError).code).toBe(OntologyErrorCode.DUPLICATE_RESOURCE)
  })

  it('RESOURCE_NOT_FOUND: updateResource throws same .code from both adapters', async () => {
    const inMemory = makeAdapter()

    const inMemErr = await inMemory.updateResource('nonexistent-id', { config: {} }).catch(e => e)
    expect(inMemErr).toBeInstanceOf(OntologyError)
    expect((inMemErr as OntologyError).code).toBe(OntologyErrorCode.RESOURCE_NOT_FOUND)

    fakeSql.mockRejectedValueOnce(new Error('Resource not found: nonexistent-id'))
    const pgErr = await pgAdapter.updateResource('nonexistent-id', { config: {} }).catch(e => e)
    expect(pgErr).toBeInstanceOf(OntologyError)
    expect((pgErr as OntologyError).code).toBe(OntologyErrorCode.RESOURCE_NOT_FOUND)
  })

  it('RESOURCE_NOT_FOUND: removeResource throws same .code from both adapters', async () => {
    const inMemory = makeAdapter()

    const inMemErr = await inMemory.removeResource('nonexistent').catch(e => e)
    expect(inMemErr).toBeInstanceOf(OntologyError)
    expect((inMemErr as OntologyError).code).toBe(OntologyErrorCode.RESOURCE_NOT_FOUND)

    fakeSql.mockResolvedValueOnce(Object.assign([], { count: 0 }))
    const pgErr = await pgAdapter.removeResource('nonexistent').catch(e => e)
    expect(pgErr).toBeInstanceOf(OntologyError)
    expect((pgErr as OntologyError).code).toBe(OntologyErrorCode.RESOURCE_NOT_FOUND)
  })
})
