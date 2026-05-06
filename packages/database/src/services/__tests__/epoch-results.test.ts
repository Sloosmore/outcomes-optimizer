import { describe, it, expect } from 'vitest'
import { EpochResultsService } from '../epoch-results.js'
import type { EpochRow } from '../epoch-results.js'

const PROCESS_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

// Mock sql that captures the last query string and returns configurable rows
function makeMockSql(returnRows: Partial<EpochRow>[] = []) {
  let lastQuery = ''
  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    lastQuery = strings.raw.join('?')
    return Promise.resolve(returnRows)
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return { mockSql, getLastQuery: () => lastQuery }
}

describe('EpochResultsService.upsert()', () => {
  it('issues an INSERT ... ON CONFLICT upsert using campaign_id', async () => {
    const { mockSql, getLastQuery } = makeMockSql()
    const service = new EpochResultsService(mockSql)
    await service.upsert(PROCESS_ID, 1, { status: 'completed' })
    const query = getLastQuery()
    expect(query).toContain('INSERT INTO epoch_results')
    expect(query).toContain('campaign_id')
    expect(query).toContain('ON CONFLICT')
    expect(query).toContain('DO UPDATE SET')
  })

  it('includes workflow_run_id in the upsert', async () => {
    const { mockSql, getLastQuery } = makeMockSql()
    const service = new EpochResultsService(mockSql)
    await service.upsert(PROCESS_ID, 2, {
      status: 'running',
      workflowRunId: 'wfr-123',
      cost: 0.05,
      durationMs: 5000,
      sessionId: 'sess-abc',
      stateSnapshot: { key: 'val' },
      startedAt: new Date('2024-01-01T00:00:00Z'),
      completedAt: new Date('2024-01-01T01:00:00Z'),
    })
    const query = getLastQuery()
    expect(query).toContain('workflow_run_id')
  })

  it('returns void on success', async () => {
    const { mockSql } = makeMockSql()
    const service = new EpochResultsService(mockSql)
    const result = await service.upsert(PROCESS_ID, 1, { status: 'completed' })
    expect(result).toBeUndefined()
  })
})

describe('EpochResultsService.getByProcessId()', () => {
  const rows: Partial<EpochRow>[] = [
    { id: 'id-1', campaign_id: PROCESS_ID, epoch_number: 1, status: 'completed', cost: null, duration_ms: null, session_id: null, workflow_run_id: null, state_snapshot: null, started_at: null, completed_at: null },
    { id: 'id-2', campaign_id: PROCESS_ID, epoch_number: 2, status: 'completed', cost: null, duration_ms: null, session_id: null, workflow_run_id: null, state_snapshot: null, started_at: null, completed_at: null },
  ]

  it('queries epoch_results WHERE campaign_id ordered ASC', async () => {
    const { mockSql, getLastQuery } = makeMockSql(rows)
    const service = new EpochResultsService(mockSql)
    await service.getByProcessId(PROCESS_ID)
    const query = getLastQuery()
    expect(query).toContain('epoch_results')
    expect(query).toContain('campaign_id')
    expect(query).toContain('ORDER BY epoch_number ASC')
  })

  it('returns array of rows', async () => {
    const { mockSql } = makeMockSql(rows)
    const service = new EpochResultsService(mockSql)
    const result = await service.getByProcessId(PROCESS_ID)
    expect(result).toHaveLength(2)
    expect(result[0].epoch_number).toBe(1)
    expect(result[1].epoch_number).toBe(2)
  })

  it('includes LIMIT in query when limit is provided', async () => {
    const { mockSql, getLastQuery } = makeMockSql(rows)
    const service = new EpochResultsService(mockSql)
    await service.getByProcessId(PROCESS_ID, 5)
    const query = getLastQuery()
    expect(query).toContain('LIMIT')
  })

  it('returns empty array when no rows exist', async () => {
    const { mockSql } = makeMockSql([])
    const service = new EpochResultsService(mockSql)
    const result = await service.getByProcessId(PROCESS_ID)
    expect(result).toHaveLength(0)
  })
})

describe('EpochResultsService.getLatest()', () => {
  it('queries epoch_results ordered DESC LIMIT 1', async () => {
    const { mockSql, getLastQuery } = makeMockSql([])
    const service = new EpochResultsService(mockSql)
    await service.getLatest(PROCESS_ID)
    const query = getLastQuery()
    expect(query).toContain('campaign_id')
    expect(query).toContain('ORDER BY epoch_number DESC')
    expect(query).toContain('LIMIT 1')
  })

  it('returns null when no rows exist', async () => {
    const { mockSql } = makeMockSql([])
    const service = new EpochResultsService(mockSql)
    const result = await service.getLatest(PROCESS_ID)
    expect(result).toBeNull()
  })

  it('returns single row when a row exists', async () => {
    const row: Partial<EpochRow> = {
      id: 'id-5',
      campaign_id: PROCESS_ID,
      epoch_number: 5,
      status: 'completed',
      cost: 1.23,
      duration_ms: 9000,
      session_id: 'sess-xyz',
      workflow_run_id: null,
      state_snapshot: { done: true },
      started_at: null,
      completed_at: null,
    }
    const { mockSql } = makeMockSql([row])
    const service = new EpochResultsService(mockSql)
    const result = await service.getLatest(PROCESS_ID)
    expect(result).not.toBeNull()
    expect(result!.epoch_number).toBe(5)
    expect(result!.status).toBe('completed')
    expect(result!.cost).toBe(1.23)
  })
})
