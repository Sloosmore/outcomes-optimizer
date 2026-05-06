/**
 * Unit tests for packages/database/src/utils/process-dependencies.ts
 * All DB calls are mocked — no real database connection.
 *
 * DB-level constraints (FK cascade/restrict, self-loop CHECK, cycle detection trigger)
 * are verified against a Supabase branch as part of the migration acceptance criteria.
 */

// ── hoist mock fns so factories can reference them ────────────────────────────
const { mockGetDb } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
}))

// ── module mocks ──────────────────────────────────────────────────────────────
vi.mock('../../drizzle-client.js', () => ({
  getDb: mockGetDb,
}))

import { addDependency, getDependencies, getDependents, removeDependency } from '../process-dependencies.js'

// ── helpers ───────────────────────────────────────────────────────────────────

const PROCESS_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const PROCESS_B = 'bbbbbbbb-0000-0000-0000-000000000002'
const PROCESS_C = 'cccccccc-0000-0000-0000-000000000003'
const NOW = new Date('2026-01-01T00:00:00Z')

/** Simulate: db.insert(t).values(v).onConflictDoNothing() */
function makeInsertMock() {
  const onConflictDoNothing = vi.fn().mockResolvedValue([])
  const values = vi.fn(() => ({ onConflictDoNothing }))
  const insert = vi.fn(() => ({ values }))
  return { insert, values, onConflictDoNothing }
}

/** Simulate: db.select().from(t).where(cond) returning rows */
function makeSelectMock(returnValue: unknown[]) {
  const where = vi.fn().mockResolvedValue(returnValue)
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  return { select, from, where }
}

/** Simulate: db.delete(t).where(cond) */
function makeDeleteMock() {
  const where = vi.fn().mockResolvedValue([])
  const del = vi.fn(() => ({ where }))
  return { delete: del, where }
}

// ── addDependency ─────────────────────────────────────────────────────────────

describe('addDependency', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls insert with correct processId and dependencyId', async () => {
    const mock = makeInsertMock()
    mockGetDb.mockReturnValue(mock)

    await addDependency(PROCESS_A, PROCESS_B)

    expect(mock.insert).toHaveBeenCalledOnce()
    expect(mock.values).toHaveBeenCalledWith({ processId: PROCESS_A, dependencyId: PROCESS_B })
    expect(mock.onConflictDoNothing).toHaveBeenCalledOnce()
  })

  it('is idempotent — calling twice does not throw (onConflictDoNothing)', async () => {
    const mock = makeInsertMock()
    mockGetDb.mockReturnValue(mock)

    await expect(addDependency(PROCESS_A, PROCESS_B)).resolves.toBeUndefined()
    await expect(addDependency(PROCESS_A, PROCESS_B)).resolves.toBeUndefined()
  })

  it('throws immediately when processId === dependencyId (self-loop guard)', async () => {
    await expect(addDependency(PROCESS_A, PROCESS_A)).rejects.toThrow('A process cannot depend on itself')
    // DB should never be called for a self-loop
    expect(mockGetDb).not.toHaveBeenCalled()
  })

  it('propagates DB errors (e.g. cycle detection trigger rejection)', async () => {
    const onConflictDoNothing = vi.fn().mockRejectedValue(
      new Error('Dependency cycle detected: a → b')
    )
    const values = vi.fn(() => ({ onConflictDoNothing }))
    const insert = vi.fn(() => ({ values }))
    mockGetDb.mockReturnValue({ insert, values, onConflictDoNothing })

    await expect(addDependency(PROCESS_B, PROCESS_A)).rejects.toThrow('Dependency cycle detected')
  })
})

// ── getDependencies ───────────────────────────────────────────────────────────

describe('getDependencies', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const rowA = { processId: PROCESS_A, dependencyId: PROCESS_B, createdAt: NOW }
  const rowB = { processId: PROCESS_A, dependencyId: PROCESS_C, createdAt: NOW }

  it('returns all dependency rows for a given processId', async () => {
    const mock = makeSelectMock([rowA, rowB])
    mockGetDb.mockReturnValue(mock)

    const result = await getDependencies(PROCESS_A)

    expect(result).toEqual([rowA, rowB])
    expect(mock.select).toHaveBeenCalledOnce()
    expect(mock.from).toHaveBeenCalledOnce()
    expect(mock.where).toHaveBeenCalledOnce()
  })

  it('returns empty array when process has no dependencies', async () => {
    const mock = makeSelectMock([])
    mockGetDb.mockReturnValue(mock)

    const result = await getDependencies(PROCESS_A)

    expect(result).toEqual([])
  })
})

// ── getDependents ─────────────────────────────────────────────────────────────

describe('getDependents', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const rowA = { processId: PROCESS_B, dependencyId: PROCESS_A, createdAt: NOW }
  const rowB = { processId: PROCESS_C, dependencyId: PROCESS_A, createdAt: NOW }

  it('returns all rows where the given campaign is a dependency', async () => {
    const mock = makeSelectMock([rowA, rowB])
    mockGetDb.mockReturnValue(mock)

    const result = await getDependents(PROCESS_A)

    expect(result).toEqual([rowA, rowB])
    expect(mock.select).toHaveBeenCalledOnce()
    expect(mock.from).toHaveBeenCalledOnce()
    expect(mock.where).toHaveBeenCalledOnce()
  })

  it('returns empty array when no processes depend on this campaign', async () => {
    const mock = makeSelectMock([])
    mockGetDb.mockReturnValue(mock)

    const result = await getDependents(PROCESS_C)

    expect(result).toEqual([])
  })
})

// ── removeDependency ──────────────────────────────────────────────────────────

describe('removeDependency', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls delete with the correct composite condition', async () => {
    const mock = makeDeleteMock()
    mockGetDb.mockReturnValue(mock)

    await removeDependency(PROCESS_A, PROCESS_B)

    expect(mock.delete).toHaveBeenCalledOnce()
    expect(mock.where).toHaveBeenCalledOnce()
  })

  it('resolves without error when the row does not exist', async () => {
    const mock = makeDeleteMock()
    mockGetDb.mockReturnValue(mock)

    await expect(removeDependency(PROCESS_A, PROCESS_C)).resolves.toBeUndefined()
  })
})
