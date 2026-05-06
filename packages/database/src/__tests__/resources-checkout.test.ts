/**
 * Unit tests for checkout/release/available behaviour in packages/database/src/resources.ts
 * All DB calls are mocked — no real database connection.
 */

// ── hoist mock fns so factories can reference them ────────────────────────────
const {
  mockGetDb,
  mockIsDatabaseEnabled,
  mockUpsertTag,
  mockAttachTag,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockIsDatabaseEnabled: vi.fn(),
  mockUpsertTag: vi.fn(),
  mockAttachTag: vi.fn(),
}))

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('../drizzle-client.js', () => ({
  getDb: mockGetDb,
  isDatabaseEnabled: mockIsDatabaseEnabled,
}))

vi.mock('../utils/tags.js', () => ({
  upsertTag: mockUpsertTag,
  attachTag: mockAttachTag,
}))

// Import under test AFTER mocks are registered
import { checkoutResource, releaseResource, getAvailableResources } from '../resources.js'

// ── helpers ───────────────────────────────────────────────────────────────────

const RESOURCE_ID = '11111111-2222-3333-4444-555555555555'
const CREATED_AT = new Date('2026-01-01T00:00:00Z')

const mockResource = {
  id: RESOURCE_ID,
  name: 'test-resource',
  type: 'identity',
  status: 'active',
  config: {},
  notes: null,
  lockedBy: 'agent-1',
  lockedAt: CREATED_AT,
  metadata: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
}

const unlockedResource = {
  ...mockResource,
  lockedBy: null,
  lockedAt: null,
}

/**
 * Build a mock that simulates:
 *   db.update(resources).set({...}).where(...).returning()
 */
function makeUpdateReturningMock(returnValue: unknown[]) {
  const returning = vi.fn().mockResolvedValue(returnValue)
  const where = vi.fn(() => ({ returning }))
  const set = vi.fn(() => ({ where }))
  const update = vi.fn(() => ({ set }))
  return { update, set, where, returning }
}

/**
 * Build a mock that simulates:
 *   db.select({...}).from(resources).where(...)
 * returning a single row.
 */
function makeSelectOneMock(returnValue: unknown[]) {
  const where = vi.fn().mockResolvedValue(returnValue)
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  return { select, from, where }
}

/**
 * Build a mock that simulates:
 *   db.select().from(resources).where(...)
 * returning multiple rows.
 */
function makeSelectManyMock(returnValue: unknown[]) {
  const where = vi.fn().mockResolvedValue(returnValue)
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  return { select, from, where }
}

/**
 * Build a mock that simulates:
 *   db.select({resource: resources}).from(resources).innerJoin(...).innerJoin(...).where(...)
 * returning the provided rows.
 */
function makeJoinSelectMock(returnValue: unknown[]) {
  const where = vi.fn().mockResolvedValue(returnValue)
  const innerJoin2 = vi.fn(() => ({ where }))
  const innerJoin1 = vi.fn(() => ({ innerJoin: innerJoin2 }))
  const from = vi.fn(() => ({ innerJoin: innerJoin1 }))
  const select = vi.fn(() => ({ from }))
  return { select, from, innerJoin1, innerJoin2, where }
}

// ── checkoutResource ──────────────────────────────────────────────────────────

describe('checkoutResource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('succeeds on unlocked resource (update returns resource)', async () => {
    const updateMock = makeUpdateReturningMock([mockResource])
    mockGetDb.mockReturnValue(updateMock)

    const result = await checkoutResource('test-resource', 'agent-1')

    expect(result).toEqual(mockResource)
    expect(updateMock.update).toHaveBeenCalledOnce()
    expect(updateMock.returning).toHaveBeenCalledOnce()
  })

  it('throws "already locked by X" when update returns [] and select finds locker', async () => {
    // db needs to handle both update (returns []) and select (returns [{lockedBy: 'other-locker'}])
    const returning = vi.fn().mockResolvedValue([])
    const updateWhere = vi.fn(() => ({ returning }))
    const set = vi.fn(() => ({ where: updateWhere }))
    const update = vi.fn(() => ({ set }))

    const selectWhere = vi.fn().mockResolvedValue([{ lockedBy: 'other-locker' }])
    const from = vi.fn(() => ({ where: selectWhere }))
    const select = vi.fn(() => ({ from }))

    mockGetDb.mockReturnValue({ update, set, where: updateWhere, returning, select, from })

    await expect(checkoutResource('test-resource', 'agent-1')).rejects.toThrow('already locked by other-locker')
  })

  it('throws "Resource not found" when update returns [] and select returns []', async () => {
    const returning = vi.fn().mockResolvedValue([])
    const updateWhere = vi.fn(() => ({ returning }))
    const set = vi.fn(() => ({ where: updateWhere }))
    const update = vi.fn(() => ({ set }))

    const selectWhere = vi.fn().mockResolvedValue([])
    const from = vi.fn(() => ({ where: selectWhere }))
    const select = vi.fn(() => ({ from }))

    mockGetDb.mockReturnValue({ update, set, where: updateWhere, returning, select, from })

    await expect(checkoutResource('nonexistent', 'agent-1')).rejects.toThrow('Resource not found: nonexistent')
  })
})

// ── releaseResource ───────────────────────────────────────────────────────────

describe('releaseResource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('succeeds with correct locker (atomic update returns resource)', async () => {
    const updateMock = makeUpdateReturningMock([unlockedResource])
    mockGetDb.mockReturnValue(updateMock)

    await expect(releaseResource('test-resource', 'agent-1')).resolves.toBeUndefined()
    expect(updateMock.update).toHaveBeenCalledOnce()
    expect(updateMock.returning).toHaveBeenCalledOnce()
  })

  it('throws "Cannot release: resource is locked by X, not Y" with wrong locker', async () => {
    // Atomic update returns [] (lockerId mismatch), then select reveals current locker
    const updateReturning = vi.fn().mockResolvedValue([])
    const updateWhere = vi.fn(() => ({ returning: updateReturning }))
    const updateSet = vi.fn(() => ({ where: updateWhere }))
    const update = vi.fn(() => ({ set: updateSet }))

    const selectWhere = vi.fn().mockResolvedValue([{ lockedBy: 'agent-1' }])
    const from = vi.fn(() => ({ where: selectWhere }))
    const select = vi.fn(() => ({ from }))

    mockGetDb.mockReturnValue({ update, set: updateSet, where: updateWhere, returning: updateReturning, select, from })

    await expect(releaseResource('test-resource', 'agent-2')).rejects.toThrow(
      'Cannot release: resource is locked by agent-1, not agent-2'
    )
  })

  it('throws "Resource is not locked" when lockedBy is null', async () => {
    // Atomic update returns [] (resource not locked), then select shows lockedBy=null
    const updateReturning = vi.fn().mockResolvedValue([])
    const updateWhere = vi.fn(() => ({ returning: updateReturning }))
    const updateSet = vi.fn(() => ({ where: updateWhere }))
    const update = vi.fn(() => ({ set: updateSet }))

    const selectWhere = vi.fn().mockResolvedValue([{ lockedBy: null }])
    const from = vi.fn(() => ({ where: selectWhere }))
    const select = vi.fn(() => ({ from }))

    mockGetDb.mockReturnValue({ update, set: updateSet, where: updateWhere, returning: updateReturning, select, from })

    await expect(releaseResource('test-resource', 'agent-1')).rejects.toThrow(
      'Resource is not locked: test-resource'
    )
  })
})

// ── getAvailableResources ─────────────────────────────────────────────────────

describe('getAvailableResources', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all unlocked resources when no filters provided', async () => {
    const selectMock = makeSelectManyMock([unlockedResource])
    mockGetDb.mockReturnValue(selectMock)

    const result = await getAvailableResources()

    expect(result).toEqual([unlockedResource])
    expect(selectMock.select).toHaveBeenCalledOnce()
    expect(selectMock.where).toHaveBeenCalledOnce()
  })

  it('filters by type (WHERE lockedBy IS NULL AND type=X)', async () => {
    const selectMock = makeSelectManyMock([unlockedResource])
    mockGetDb.mockReturnValue(selectMock)

    const result = await getAvailableResources({ type: 'identity' })

    expect(result).toEqual([unlockedResource])
    expect(selectMock.where).toHaveBeenCalledOnce()
  })

  it('filters by tag (join path)', async () => {
    const rows = [{ resource: unlockedResource }]
    const joinMock = makeJoinSelectMock(rows)
    mockGetDb.mockReturnValue(joinMock)

    const result = await getAvailableResources({ tag: 'prod' })

    expect(result).toEqual([unlockedResource])
    expect(joinMock.select).toHaveBeenCalledOnce()
    expect(joinMock.innerJoin1).toHaveBeenCalledOnce()
    expect(joinMock.innerJoin2).toHaveBeenCalledOnce()
    expect(joinMock.where).toHaveBeenCalledOnce()
  })

  it('filters by tag AND type (join path with type condition)', async () => {
    const rows = [{ resource: unlockedResource }]
    const joinMock = makeJoinSelectMock(rows)
    mockGetDb.mockReturnValue(joinMock)

    const result = await getAvailableResources({ tag: 'prod', type: 'identity' })

    expect(result).toEqual([unlockedResource])
    expect(joinMock.select).toHaveBeenCalledOnce()
    expect(joinMock.where).toHaveBeenCalledOnce()
  })
})
