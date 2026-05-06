import { describe, it, expect } from 'vitest'
import { EventsService } from '../events.js'

/**
 * Stateful mock SQL factory.
 *
 * `rows` is the array of rows returned for SELECT queries.
 * `capturedQuery` and `capturedValues` record the most recent query for inspection.
 * `jsonCalled` tracks whether sql.json() was invoked (for insertAgentEvent tests).
 */
function makeMockSql(opts: {
  rows?: Record<string, unknown>[]
} = {}) {
  const { rows = [] } = opts

  let capturedQuery = ''
  let capturedValues: unknown[] = []
  let jsonCalled = false
  let jsonArg: unknown = undefined

  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    capturedQuery = strings.raw.join('?')
    capturedValues = values

    if (capturedQuery.includes('INSERT INTO agent_events')) {
      return Promise.resolve([])
    }

    if (capturedQuery.includes('COUNT(*)')) {
      return Promise.resolve(rows)
    }

    if (capturedQuery.includes('SELECT id, process_id')) {
      return Promise.resolve(rows)
    }

    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>

  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => {
    jsonCalled = true
    jsonArg = obj
    return obj
  }

  return {
    sql: mockSql,
    getCapturedQuery: () => capturedQuery,
    getCapturedValues: () => capturedValues,
    wasJsonCalled: () => jsonCalled,
    getJsonArg: () => jsonArg,
  }
}

// ── EventsService.getByProcessIds() ──────────────────────────────────────────

describe('EventsService.getByProcessIds()', () => {
  it('returns empty array immediately when processIds is empty (no SQL called)', async () => {
    const { sql, getCapturedQuery } = makeMockSql()
    const service = new EventsService(sql)
    const result = await service.getByProcessIds([])
    expect(result).toEqual([])
    expect(getCapturedQuery()).toBe('')
  })

  it('no cursor: fetches DESC and reverses to ascending order', async () => {
    // Simulate rows returned in DESC order (newest first) — service reverses them
    const rows = [
      { id: 'e3', process_id: 'p1', process_name: 'proc', resource_id: null, source: 'process_continued', payload: {}, ts: '2024-01-03T00:00:00.000Z' },
      { id: 'e2', process_id: 'p1', process_name: 'proc', resource_id: null, source: 'process_continued', payload: {}, ts: '2024-01-02T00:00:00.000Z' },
      { id: 'e1', process_id: 'p1', process_name: 'proc', resource_id: null, source: 'process_continued', payload: {}, ts: '2024-01-01T00:00:00.000Z' },
    ]
    const { sql, getCapturedQuery } = makeMockSql({ rows })
    const service = new EventsService(sql)
    const result = await service.getByProcessIds(['p1'])

    // Should be reversed to ascending
    expect(result[0].id).toBe('e1')
    expect(result[1].id).toBe('e2')
    expect(result[2].id).toBe('e3')

    const query = getCapturedQuery()
    expect(query).toContain('ORDER BY ts DESC')
    expect(query).not.toContain('AND ts >')
    expect(query).not.toContain('AND ts <')
  })

  it('after cursor: uses ASC query path without before', async () => {
    const rows = [
      { id: 'e2', process_id: 'p1', process_name: 'proc', resource_id: null, source: 'process_continued', payload: {}, ts: '2024-01-02T00:00:00.000Z' },
    ]
    const { sql, getCapturedQuery } = makeMockSql({ rows })
    const service = new EventsService(sql)
    const result = await service.getByProcessIds(['p1'], { after: '2024-01-01T00:00:00.000Z' })

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('e2')

    const query = getCapturedQuery()
    expect(query).toContain('ORDER BY ts ASC')
    expect(query).toContain('AND ts > ?')
    expect(query).not.toContain('AND ts <')
  })

  it('after + before cursors: uses ASC query path with both bounds', async () => {
    const rows = [
      { id: 'e2', process_id: 'p1', process_name: 'proc', resource_id: null, source: 'process_continued', payload: {}, ts: '2024-01-02T00:00:00.000Z' },
    ]
    const { sql, getCapturedQuery } = makeMockSql({ rows })
    const service = new EventsService(sql)
    const result = await service.getByProcessIds(['p1'], {
      after: '2024-01-01T00:00:00.000Z',
      before: '2024-01-03T00:00:00.000Z',
    })

    expect(result).toHaveLength(1)

    const query = getCapturedQuery()
    expect(query).toContain('ORDER BY ts ASC')
    expect(query).toContain('AND ts > ?')
    expect(query).toContain('AND ts < ?')
  })

  it('before cursor only: fetches DESC and reverses to ascending order', async () => {
    // Rows returned in DESC order — service reverses them
    const rows = [
      { id: 'e2', process_id: 'p1', process_name: 'proc', resource_id: null, source: 'process_continued', payload: {}, ts: '2024-01-02T00:00:00.000Z' },
      { id: 'e1', process_id: 'p1', process_name: 'proc', resource_id: null, source: 'process_continued', payload: {}, ts: '2024-01-01T00:00:00.000Z' },
    ]
    const { sql, getCapturedQuery } = makeMockSql({ rows })
    const service = new EventsService(sql)
    const result = await service.getByProcessIds(['p1'], { before: '2024-01-03T00:00:00.000Z' })

    // Should be reversed to ascending
    expect(result[0].id).toBe('e1')
    expect(result[1].id).toBe('e2')

    const query = getCapturedQuery()
    expect(query).toContain('ORDER BY ts DESC')
    expect(query).toContain('AND ts < ?')
    expect(query).not.toContain('AND ts >')
  })

  it('maps row fields correctly: snake_case → camelCase', async () => {
    const rows = [
      {
        id: 'event-uuid',
        process_id: 'proc-uuid',
        process_name: 'my-process',
        resource_id: 'res-uuid',
        source: 'process_continued',
        payload: { key: 'value' },
        ts: '2024-06-01T12:00:00.000Z',
      },
    ]
    const { sql } = makeMockSql({ rows })
    const service = new EventsService(sql)
    const result = await service.getByProcessIds(['proc-uuid'])

    expect(result).toHaveLength(1)
    const event = result[0]
    expect(event.id).toBe('event-uuid')
    expect(event.processId).toBe('proc-uuid')
    expect(event.processName).toBe('my-process')
    expect(event.resourceId).toBe('res-uuid')
    expect(event.source).toBe('process_continued')
    expect(event.payload).toEqual({ key: 'value' })
    expect(event.ts).toBe('2024-06-01T12:00:00.000Z')
  })

  it('converts Date ts to ISO string', async () => {
    const date = new Date('2024-06-15T10:30:00.000Z')
    const rows = [
      {
        id: 'event-1',
        process_id: 'p1',
        process_name: 'proc',
        resource_id: null,
        source: 'process_continued',
        payload: {},
        ts: date,
      },
    ]
    const { sql } = makeMockSql({ rows })
    const service = new EventsService(sql)
    const result = await service.getByProcessIds(['p1'])

    expect(result[0].ts).toBe('2024-06-15T10:30:00.000Z')
  })

  it('handles null resource_id correctly', async () => {
    const rows = [
      {
        id: 'event-1',
        process_id: 'p1',
        process_name: 'proc',
        resource_id: null,
        source: 'process_continued',
        payload: {},
        ts: '2024-01-01T00:00:00.000Z',
      },
    ]
    const { sql } = makeMockSql({ rows })
    const service = new EventsService(sql)
    const result = await service.getByProcessIds(['p1'])

    expect(result[0].resourceId).toBeNull()
  })
})

// ── EventsService.countByProcessIds() ────────────────────────────────────────

describe('EventsService.countByProcessIds()', () => {
  it('returns 0 immediately when processIds is empty (no SQL called)', async () => {
    const { sql, getCapturedQuery } = makeMockSql()
    const service = new EventsService(sql)
    const count = await service.countByProcessIds([])
    expect(count).toBe(0)
    expect(getCapturedQuery()).toBe('')
  })

  it('returns count as number (not string) — DB returns string for COUNT', async () => {
    const { sql } = makeMockSql({ rows: [{ count: '42' }] })
    const service = new EventsService(sql)
    const count = await service.countByProcessIds(['p1'])
    expect(count).toBe(42)
    expect(typeof count).toBe('number')
  })

  it('returns 0 when COUNT returns "0" as string', async () => {
    const { sql } = makeMockSql({ rows: [{ count: '0' }] })
    const service = new EventsService(sql)
    const count = await service.countByProcessIds(['p1', 'p2'])
    expect(count).toBe(0)
  })
})

// ── EventsService.insertAgentEvent() ─────────────────────────────────────────

describe('EventsService.insertAgentEvent()', () => {
  it('calls INSERT with correct fields and resolves without error', async () => {
    const { sql, getCapturedQuery, getCapturedValues } = makeMockSql()
    const service = new EventsService(sql)

    await expect(
      service.insertAgentEvent({
        processId: 'proc-1',
        processName: 'my-process',
        resourceId: 'res-1',
        source: 'process_continued',
        payload: { foo: 'bar' },
      }),
    ).resolves.toBeUndefined()

    const query = getCapturedQuery()
    expect(query).toContain('INSERT INTO agent_events')
    expect(query).toContain('process_id')
    expect(query).toContain('process_name')
    expect(query).toContain('resource_id')
    expect(query).toContain('source')
    expect(query).toContain('payload')

    const values = getCapturedValues()
    expect(values).toContain('proc-1')
    expect(values).toContain('my-process')
    expect(values).toContain('res-1')
    expect(values).toContain('process_continued')
  })

  it('uses sql.json() for the payload argument', async () => {
    const { sql, wasJsonCalled, getJsonArg } = makeMockSql()
    const service = new EventsService(sql)

    const payload = { event: 'test', count: 5 }
    await service.insertAgentEvent({
      processId: 'proc-1',
      processName: 'my-process',
      resourceId: null,
      source: 'process_blocked',
      payload,
    })

    expect(wasJsonCalled()).toBe(true)
    expect(getJsonArg()).toEqual(payload)
  })

  it('handles null resourceId correctly', async () => {
    const { sql, getCapturedValues } = makeMockSql()
    const service = new EventsService(sql)

    await service.insertAgentEvent({
      processId: 'proc-1',
      processName: 'my-process',
      resourceId: null,
      source: 'goal_amended',
      payload: {},
    })

    const values = getCapturedValues()
    expect(values).toContain(null)
  })
})
