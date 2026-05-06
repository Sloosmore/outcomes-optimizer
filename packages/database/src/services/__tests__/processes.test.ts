import { describe, it, expect } from 'vitest'
import { ProcessesService } from '../processes.js'
import type { WaitingProcessRow } from '../processes.js'

/**
 * Stateful mock SQL factory.
 *
 * `updateReturnsRow` controls whether UPDATE ... RETURNING id returns the process row (success)
 * or an empty array (triggers the fallback SELECT path).
 *
 * `processRow` is what SELECT id, status FROM processes returns when the UPDATE returns empty.
 *
 * `getByNameRows` overrides what getByName() returns (array of ProcessRow). If not provided,
 * falls back to wrapping processRow in an array (or [] if null).
 */
function makeMockSql(opts: {
  processRow?: { id: string; name: string; status: string } | null
  resourceRow?: { id: string } | null
  insertedId?: string | null
  updateReturnsRow?: boolean
  getByNameRows?: { id: string; name: string; status: string; updated_at: Date | null }[] | null
} = {}) {
  const {
    processRow = null,
    resourceRow = null,
    insertedId = null,
    updateReturnsRow = true,
    getByNameRows = undefined,
  } = opts

  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const query = strings.raw.join('?')

    // INSERT INTO processes — new process creation
    if (query.includes('INSERT INTO processes')) {
      return Promise.resolve(insertedId ? [{ id: insertedId }] : [])
    }

    // SELECT ... FROM processes WHERE name = ? ORDER BY updated_at DESC (getByName)
    if (query.includes('FROM processes WHERE name') && query.includes('ORDER BY updated_at DESC')) {
      if (getByNameRows !== undefined) {
        return Promise.resolve(getByNameRows ?? [])
      }
      return Promise.resolve(processRow ? [processRow] : [])
    }

    // UPDATE processes ... RETURNING id (state transitions)
    if (query.includes('UPDATE processes') && query.includes('RETURNING id')) {
      return Promise.resolve(updateReturnsRow && processRow ? [{ id: processRow.id }] : [])
    }

    // SELECT id, status FROM processes WHERE id = ... (fallback status check)
    if (query.includes('SELECT id, status FROM processes')) {
      return Promise.resolve(processRow ? [processRow] : [])
    }

    // SELECT id FROM resources WHERE name = ... AND type = 'data'
    if (query.includes('SELECT id FROM resources')) {
      return Promise.resolve(resourceRow ? [{ id: resourceRow.id }] : [])
    }

    // INSERT INTO agent_events — ignore silently
    if (query.includes('INSERT INTO agent_events')) {
      return Promise.resolve([])
    }

    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>

  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj

  return mockSql
}

// ── ProcessesService.init() ───────────────────────────────────────────────────

describe('ProcessesService.init()', () => {
  it('creates a process and returns its UUID', async () => {
    const sql = makeMockSql({ insertedId: 'new-process-id' })
    const service = new ProcessesService(sql)
    const id = await service.init({ name: 'test-process' })
    expect(id).toBe('new-process-id')
  })

  it('throws a descriptive error when INSERT returns no rows', async () => {
    const sql = makeMockSql({ insertedId: null })
    const service = new ProcessesService(sql)
    await expect(service.init({ name: 'ghost-process' })).rejects.toThrow(
      'Failed to insert process "ghost-process": INSERT returned no rows',
    )
  })
})

// ── ProcessesService.getByName() ─────────────────────────────────────────────

describe('ProcessesService.getByName()', () => {
  it('returns [] when no rows match', async () => {
    const sql = makeMockSql({ getByNameRows: [] })
    const service = new ProcessesService(sql)
    const result = await service.getByName('nonexistent')
    expect(result).toEqual([])
  })

  it('returns [row] when exactly one row matches', async () => {
    const row = { id: 'proc-1', name: 'existing', status: 'active', updated_at: new Date('2026-01-01') }
    const sql = makeMockSql({ getByNameRows: [row] })
    const service = new ProcessesService(sql)
    const result = await service.getByName('existing')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('proc-1')
    expect(result[0].name).toBe('existing')
    expect(result[0].status).toBe('active')
  })

  it('returns all three rows ordered newest-first when three rows match', async () => {
    const rows = [
      { id: 'proc-3', name: 'multi', status: 'active', updated_at: new Date('2026-03-01') },
      { id: 'proc-2', name: 'multi', status: 'completed', updated_at: new Date('2026-02-01') },
      { id: 'proc-1', name: 'multi', status: 'failed', updated_at: new Date('2026-01-01') },
    ]
    const sql = makeMockSql({ getByNameRows: rows })
    const service = new ProcessesService(sql)
    const result = await service.getByName('multi')
    expect(result).toHaveLength(3)
    expect(result[0].id).toBe('proc-3')
    expect(result[1].id).toBe('proc-2')
    expect(result[2].id).toBe('proc-1')
  })
})

// ── ProcessesService.activate() ──────────────────────────────────────────────

describe('ProcessesService.activate()', () => {
  it('activates a pending process successfully', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'pending' },
      updateReturnsRow: true,
    })
    const service = new ProcessesService(sql)
    await expect(service.activate('proc-1')).resolves.toBeUndefined()
  })

  it('is idempotent when process is already active', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'active' },
      updateReturnsRow: false, // UPDATE WHERE status IN ('pending','waiting') returns nothing
    })
    const service = new ProcessesService(sql)
    await expect(service.activate('proc-1')).resolves.toBeUndefined()
  })

  it('throws when process does not exist', async () => {
    const sql = makeMockSql({
      processRow: null,
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.activate('no-such-process')).rejects.toThrow('Process not found')
  })

  it('throws when process is in a terminal state (e.g. completed)', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'completed' },
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.activate('proc-1')).rejects.toThrow('Cannot activate')
  })
})

// ── ProcessesService.complete() ──────────────────────────────────────────────

describe('ProcessesService.complete()', () => {
  it('completes an active process successfully', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'active' },
      updateReturnsRow: true,
    })
    const service = new ProcessesService(sql)
    await expect(service.complete('proc-1')).resolves.toBeUndefined()
  })

  it('is a no-op when process is already completed', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'completed' },
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    // Should resolve without throwing — idempotent
    await expect(service.complete('proc-1')).resolves.toBeUndefined()
  })

  it('throws when process is not found', async () => {
    const sql = makeMockSql({
      processRow: null,
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.complete('missing')).rejects.toThrow('Process not found')
  })
})

// ── ProcessesService.fail() ───────────────────────────────────────────────────

describe('ProcessesService.fail()', () => {
  it('fails an active process successfully', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'active' },
      updateReturnsRow: true,
    })
    const service = new ProcessesService(sql)
    await expect(service.fail('proc-1', 'something went wrong')).resolves.toBeUndefined()
  })

  it('fails a process without a reason', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'active' },
      updateReturnsRow: true,
    })
    const service = new ProcessesService(sql)
    await expect(service.fail('proc-1')).resolves.toBeUndefined()
  })

  it('is a no-op when process is already failed', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'failed' },
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.fail('proc-1')).resolves.toBeUndefined()
  })

  it('throws when process is not found', async () => {
    const sql = makeMockSql({
      processRow: null,
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.fail('missing')).rejects.toThrow('Process not found')
  })
})

// ── ProcessesService.block() ──────────────────────────────────────────────────

describe('ProcessesService.block()', () => {
  it('blocks an active process successfully', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'active' },
      updateReturnsRow: true,
    })
    const service = new ProcessesService(sql)
    await expect(service.block('proc-1', 'need human input')).resolves.toBeUndefined()
  })

  it('blocks an active process with a worktree path', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'active' },
      updateReturnsRow: true,
    })
    const service = new ProcessesService(sql)
    await expect(service.block('proc-1', 'need human input', '/some/worktree')).resolves.toBeUndefined()
  })

  it('throws when process is not active', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'completed' },
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.block('proc-1', 'reason')).rejects.toThrow('Cannot block')
  })

  it('throws when process is not found', async () => {
    const sql = makeMockSql({
      processRow: null,
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.block('missing', 'reason')).rejects.toThrow('Process not found')
  })
})

// ── ProcessesService.reset() ──────────────────────────────────────────────────

describe('ProcessesService.reset()', () => {
  it('resets a failed process back to pending', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'failed' },
      updateReturnsRow: true,
    })
    const service = new ProcessesService(sql)
    await expect(service.reset('proc-1')).resolves.toBeUndefined()
  })

  it('throws when process is not in failed state', async () => {
    const sql = makeMockSql({
      processRow: { id: 'proc-1', name: 'p', status: 'pending' },
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.reset('proc-1')).rejects.toThrow('Cannot reset')
  })

  it('throws when process is not found', async () => {
    const sql = makeMockSql({
      processRow: null,
      updateReturnsRow: false,
    })
    const service = new ProcessesService(sql)
    await expect(service.reset('missing')).rejects.toThrow('Process not found')
  })
})

// ── ProcessesService.sleep() ─────────────────────────────────────────────────

function makeSleepMockSql(opts: {
  processRow: {
    id: string
    status: string
    root_process_id: string | null
    channel_id: string | null
    skill_resource_id: string | null
    name: string
    parent_process_id: string | null
    branch: string | null
    training_resource_id: string | null
    run_type: string | null
    project_id: string | null
  }
  newSegmentId: string
  capturedProjectId?: { value: string | null }
}) {
  const { processRow, newSegmentId, capturedProjectId } = opts

  const makeTxFn = () => {
    return function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
      const query = strings.raw.join('?')

      // First call: SELECT to get current process (includes project_id column)
      if (query.includes('SELECT id, status') && query.includes('root_process_id') && query.includes('project_id')) {
        return Promise.resolve([processRow])
      }
      // COUNT query for segment numbering
      if (query.includes('COUNT(*)')) {
        return Promise.resolve([{ cnt: 1 }])
      }
      // UPDATE to complete current segment
      if (query.includes('UPDATE processes') && query.includes("status = 'completed'")) {
        return Promise.resolve([{ id: processRow.id }])
      }
      // INSERT new waiting segment — capture project_id (last positional value)
      if (query.includes('INSERT INTO processes')) {
        if (capturedProjectId) {
          capturedProjectId.value = values[values.length - 1] as string | null
        }
        return Promise.resolve([{ id: newSegmentId, resume_at: new Date() }])
      }
      return Promise.resolve([])
    } as unknown as Parameters<typeof mockSql.begin>[0] extends (tx: infer T) => unknown ? T : never
  }

  const mockSql = {
    begin: (callback: (tx: unknown) => Promise<unknown>) => callback(makeTxFn()),
  } as unknown as ReturnType<typeof import('postgres').default>

  return mockSql
}

describe('ProcessesService.sleep()', () => {
  it('propagates project_id to the new waiting segment', async () => {
    const capturedProjectId: { value: string | null } = { value: null }
    const processRow = {
      id: 'proc-1',
      status: 'active',
      root_process_id: null,
      channel_id: 'chan-1',
      skill_resource_id: null,
      name: 'my-process',
      parent_process_id: null,
      branch: null,
      training_resource_id: null,
      run_type: null,
      project_id: 'test-proj',
    }
    const sql = makeSleepMockSql({
      processRow,
      newSegmentId: 'new-segment-id',
      capturedProjectId,
    })
    const service = new ProcessesService(sql)
    const result = await service.sleep('proc-1', '30 minutes')
    expect(result.new_segment_id).toBe('new-segment-id')
    expect(capturedProjectId.value).toBe('test-proj')
  })
})

// ── ProcessesService.findWaitingProcesses() ──────────────────────────────────

function makeWaitingProcessesMockSql(rows: WaitingProcessRow[]) {
  type FragmentMarker = { __isFragment: true; innerValues: unknown[]; sqlText: string }

  const capturedFragment: { marker: FragmentMarker | null } = { marker: null }

  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): unknown {
    const query = strings.raw.join('').trim()

    // Fragment call detection — postgres.js sub-templates
    if (!query.match(/^(SELECT|UPDATE|INSERT|DELETE|WITH)\b/i)) {
      return { __isFragment: true, innerValues: values, sqlText: query } as FragmentMarker
    }

    // Main waiting processes query
    if (query.includes('SELECT id, resume_context')) {
      // Capture the fragment (first value in the outer template)
      const fragment = values[0]
      if (fragment && typeof fragment === 'object' && '__isFragment' in (fragment as object)) {
        capturedFragment.marker = fragment as FragmentMarker
      } else {
        capturedFragment.marker = null
      }
      return Promise.resolve(rows)
    }

    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>

  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj

  return { mockSql, capturedFragment }
}

describe('ProcessesService.findWaitingProcesses()', () => {
  it('(a) returns rows from the waiting query', async () => {
    const expectedRows: WaitingProcessRow[] = [
      { id: 'proc-1', resume_context: 'ctx-1' },
      { id: 'proc-2', resume_context: null },
    ]
    const { mockSql } = makeWaitingProcessesMockSql(expectedRows)
    const service = new ProcessesService(mockSql)
    const result = await service.findWaitingProcesses()
    expect(result).toEqual(expectedRows)
  })

  it('(b) filters by projectId when provided', async () => {
    const expectedRows: WaitingProcessRow[] = [
      { id: 'proc-3', resume_context: 'ctx-3' },
    ]
    const { mockSql, capturedFragment } = makeWaitingProcessesMockSql(expectedRows)
    const service = new ProcessesService(mockSql)
    const result = await service.findWaitingProcesses('proj-abc')
    expect(result).toEqual(expectedRows)
    // The fragment should filter on project_id with the provided value
    expect(capturedFragment.marker).not.toBeNull()
    expect(capturedFragment.marker!.sqlText).toContain('project_id')
    expect(capturedFragment.marker!.innerValues).toContain('proj-abc')
  })

  it('(c) returns all rows when no projectId given (backwards compat)', async () => {
    const expectedRows: WaitingProcessRow[] = [
      { id: 'proc-4', resume_context: null },
    ]
    const { mockSql, capturedFragment } = makeWaitingProcessesMockSql(expectedRows)
    const service = new ProcessesService(mockSql)
    const result = await service.findWaitingProcesses()
    expect(result).toEqual(expectedRows)
    // The empty fragment carries no values and no project_id filter
    expect(capturedFragment.marker).not.toBeNull()
    expect(capturedFragment.marker!.innerValues).toHaveLength(0)
    expect(capturedFragment.marker!.sqlText).not.toContain('project_id')
  })

  it('(d) returns empty array when no processes match', async () => {
    const { mockSql } = makeWaitingProcessesMockSql([])
    const service = new ProcessesService(mockSql)
    const result = await service.findWaitingProcesses()
    expect(result).toEqual([])
  })
})

// ── ProcessesService.resolveTrainingSetId() ───────────────────────────────────

describe('ProcessesService.resolveTrainingSetId()', () => {
  it('returns the resource ID when found', async () => {
    const sql = makeMockSql({ resourceRow: { id: 'resource-uuid-1' } })
    const service = new ProcessesService(sql)
    const id = await service.resolveTrainingSetId('my-training-set')
    expect(id).toBe('resource-uuid-1')
  })

  it('throws when no data resource matches the name', async () => {
    const sql = makeMockSql({ resourceRow: null })
    const service = new ProcessesService(sql)
    await expect(service.resolveTrainingSetId('nonexistent-set')).rejects.toThrow(
      'No data resource found with name',
    )
  })
})
