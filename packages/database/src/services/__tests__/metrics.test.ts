import { describe, it, expect } from 'vitest'
import { MetricsService } from '../metrics.js'

function makeMockSql(resourceRow: { id: string; type: string } | undefined = undefined) {
  let insertCalled = false
  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const query = strings.raw.join('')
    if (query.includes('SELECT id')) {
      return Promise.resolve(resourceRow ? [resourceRow] : [])
    }
    if (query.includes('INSERT INTO')) {
      insertCalled = true
      return Promise.resolve([])
    }
    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return { mockSql, wasInsertCalled: () => insertCalled }
}

function makeSnapshotMockSql(rows: Record<string, unknown>[]) {
  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    return Promise.resolve(rows)
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return mockSql
}

describe('MetricsService.record() — resource type guard', () => {
  it('succeeds when resource type is "skill" and issues an INSERT', async () => {
    const { mockSql, wasInsertCalled } = makeMockSql({ id: 'skill-1', type: 'skill' })
    const service = new MetricsService(mockSql)
    await expect(service.record('skill-1', 'score', 0.95)).resolves.toBeUndefined()
    expect(wasInsertCalled()).toBe(true)
  })

  it('succeeds when resource type is "agent" and issues an INSERT', async () => {
    const { mockSql, wasInsertCalled } = makeMockSql({ id: 'agent-1', type: 'agent' })
    const service = new MetricsService(mockSql)
    await expect(service.record('agent-1', 'score', 0.87)).resolves.toBeUndefined()
    expect(wasInsertCalled()).toBe(true)
  })

  it('throws when resource type is neither skill nor agent', async () => {
    const { mockSql } = makeMockSql({ id: 'data-1', type: 'data' })
    const service = new MetricsService(mockSql)
    await expect(service.record('data-1', 'score', 0.5)).rejects.toThrow(
      'is not a skill or agent'
    )
  })

  it('throws when resource does not exist', async () => {
    const { mockSql } = makeMockSql(undefined)
    const service = new MetricsService(mockSql)
    await expect(service.record('missing-id', 'score', 1.0)).rejects.toThrow(
      'Resource not found'
    )
  })

  it('throws on invalid metric key', async () => {
    const { mockSql } = makeMockSql({ id: 'skill-1', type: 'skill' })
    const service = new MetricsService(mockSql)
    await expect(service.record('skill-1', 'bad key!', 1.0)).rejects.toThrow(
      'Invalid metric key'
    )
  })

  it('throws on invalid measuredAt format', async () => {
    const { mockSql } = makeMockSql({ id: 'skill-1', type: 'skill' })
    const service = new MetricsService(mockSql)
    await expect(service.record('skill-1', 'score', 1.0, {}, 'not-a-date')).rejects.toThrow(
      'Invalid measuredAt'
    )
  })
})

describe('MetricsService.latestByKey()', () => {
  it('returns empty array when no rows match', async () => {
    const mockSql = makeSnapshotMockSql([])
    const service = new MetricsService(mockSql)
    const result = await service.latestByKey('score')
    expect(result).toEqual([])
  })

  it('maps rows to MetricSnapshot shape', async () => {
    const mockSql = makeSnapshotMockSql([
      {
        id: 'snap-1',
        skill_id: 'skill-1',
        metric_key: 'score',
        value: '0.95',
        measured_at: '2026-01-01T00:00:00Z',
        metadata: {},
      },
      {
        id: 'snap-2',
        skill_id: 'skill-2',
        metric_key: 'score',
        value: '0.80',
        measured_at: '2026-01-02T00:00:00Z',
        metadata: { source: 'test' },
      },
    ])
    const service = new MetricsService(mockSql)
    const result = await service.latestByKey('score')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      id: 'snap-1',
      skillId: 'skill-1',
      metricKey: 'score',
      value: '0.95',
      measuredAt: '2026-01-01T00:00:00Z',
      metadata: {},
    })
    expect(result[1].skillId).toBe('skill-2')
    expect(result[1].metadata).toEqual({ source: 'test' })
  })
})

describe('MetricsService.historyByKey()', () => {
  it('throws when days is not a positive integer', async () => {
    const mockSql = makeSnapshotMockSql([])
    const service = new MetricsService(mockSql)
    await expect(service.historyByKey('score', 0)).rejects.toThrow('Invalid days')
    await expect(service.historyByKey('score', -1)).rejects.toThrow('Invalid days')
    await expect(service.historyByKey('score', 3651)).rejects.toThrow('Invalid days')
  })

  it('throws when days is not an integer', async () => {
    const mockSql = makeSnapshotMockSql([])
    const service = new MetricsService(mockSql)
    await expect(service.historyByKey('score', 1.5)).rejects.toThrow('Invalid days')
  })

  it('returns empty array when no rows match', async () => {
    const mockSql = makeSnapshotMockSql([])
    const service = new MetricsService(mockSql)
    const result = await service.historyByKey('score', 7)
    expect(result).toEqual([])
  })

  it('maps rows to MetricSnapshot shape', async () => {
    const mockSql = makeSnapshotMockSql([
      {
        id: 'snap-3',
        skill_id: 'skill-1',
        metric_key: 'score',
        value: '0.75',
        measured_at: '2026-01-03T00:00:00Z',
        metadata: {},
      },
    ])
    const service = new MetricsService(mockSql)
    const result = await service.historyByKey('score', 30)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 'snap-3',
      skillId: 'skill-1',
      metricKey: 'score',
      value: '0.75',
      measuredAt: '2026-01-03T00:00:00Z',
      metadata: {},
    })
  })

  it('accepts the maximum valid days value (3650)', async () => {
    const mockSql = makeSnapshotMockSql([])
    const service = new MetricsService(mockSql)
    await expect(service.historyByKey('score', 3650)).resolves.toEqual([])
  })
})
