/**
 * Unit tests for packages/database/src/utils/tags.ts
 * All DB calls are mocked — no real database connection.
 */

// ── hoist mock fns so factories can reference them ────────────────────────────
const {
  mockGetDb,
  mockIsDatabaseEnabled,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockIsDatabaseEnabled: vi.fn(),
}))

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../drizzle-client.js', () => ({
  getDb: mockGetDb,
  isDatabaseEnabled: mockIsDatabaseEnabled,
}))

// Import under test AFTER mocks are registered
import { upsertTag, attachTag, getTagsForEntity } from '../tags.js'

// ── helpers ───────────────────────────────────────────────────────────────────

const TAG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ENTITY_ID = 'ffffffff-1111-2222-3333-444444444444'
const TAG_NAME = 'skill:run'
const CREATED_AT = new Date('2026-01-01T00:00:00Z')

const mockTag = { id: TAG_ID, name: TAG_NAME, createdAt: CREATED_AT }

/**
 * Build a mock that simulates:
 *   db.insert(tags).values({name}).onConflictDoUpdate({...}).returning()
 * returning [mockTag].
 */
function makeInsertReturningMock(returnValue: unknown[]) {
  const returning = vi.fn().mockResolvedValue(returnValue)
  const onConflictDoUpdate = vi.fn(() => ({ returning }))
  const onConflictDoNothing = vi.fn().mockResolvedValue([])
  const values = vi.fn(() => ({ onConflictDoUpdate, onConflictDoNothing }))
  const insert = vi.fn(() => ({ values }))
  return { insert, values, onConflictDoUpdate, onConflictDoNothing, returning }
}

/**
 * Build a mock that simulates:
 *   db.select({...}).from(entityTags).innerJoin(tags, ...).where(...)
 * returning the provided rows.
 */
function makeSelectMock(returnValue: unknown[]) {
  const where = vi.fn().mockResolvedValue(returnValue)
  const innerJoin = vi.fn(() => ({ where }))
  const from = vi.fn(() => ({ innerJoin }))
  const select = vi.fn(() => ({ from }))
  return { select, from, innerJoin, where }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('upsertTag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a Tag object with id, name, createdAt', async () => {
    const mock = makeInsertReturningMock([mockTag])
    mockGetDb.mockReturnValue(mock)

    const result = await upsertTag(TAG_NAME)

    expect(result).toEqual({ id: TAG_ID, name: TAG_NAME, createdAt: CREATED_AT })
  })

  it('is idempotent — calling twice with the same name returns the same tag shape', async () => {
    const mock = makeInsertReturningMock([mockTag])
    mockGetDb.mockReturnValue(mock)

    const first = await upsertTag(TAG_NAME)
    const second = await upsertTag(TAG_NAME)

    expect(first).toEqual(second)
  })

  it('calls db.insert with correct values and onConflictDoUpdate', async () => {
    const mock = makeInsertReturningMock([mockTag])
    mockGetDb.mockReturnValue(mock)

    await upsertTag(TAG_NAME)

    expect(mock.insert).toHaveBeenCalledOnce()
    expect(mock.values).toHaveBeenCalledWith({ name: TAG_NAME })
    expect(mock.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { name: TAG_NAME } })
    )
    expect(mock.returning).toHaveBeenCalledOnce()
  })
})

describe('attachTag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls db.insert with correct values and onConflictDoNothing', async () => {
    const mock = makeInsertReturningMock([])
    mockGetDb.mockReturnValue(mock)

    await attachTag(ENTITY_ID, 'trace', TAG_ID)

    expect(mock.insert).toHaveBeenCalledOnce()
    expect(mock.values).toHaveBeenCalledWith({
      entityId: ENTITY_ID,
      entityType: 'trace',
      tagId: TAG_ID,
    })
    expect(mock.onConflictDoNothing).toHaveBeenCalledOnce()
  })

  it('does not throw when called twice with the same args (onConflictDoNothing)', async () => {
    const mock = makeInsertReturningMock([])
    mockGetDb.mockReturnValue(mock)

    await expect(attachTag(ENTITY_ID, 'trace', TAG_ID)).resolves.toBeUndefined()
    await expect(attachTag(ENTITY_ID, 'trace', TAG_ID)).resolves.toBeUndefined()
  })
})

describe('getTagsForEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns an array of tags for the given entityId and entityType', async () => {
    const mock = makeSelectMock([mockTag])
    mockGetDb.mockReturnValue(mock)

    const result = await getTagsForEntity(ENTITY_ID, 'trace')

    expect(result).toEqual([mockTag])
    expect(mock.select).toHaveBeenCalledOnce()
    expect(mock.from).toHaveBeenCalledOnce()
    expect(mock.innerJoin).toHaveBeenCalledOnce()
    expect(mock.where).toHaveBeenCalledOnce()
  })

  it('returns an empty array when there are no matching tags', async () => {
    const mock = makeSelectMock([])
    mockGetDb.mockReturnValue(mock)

    const result = await getTagsForEntity(ENTITY_ID, 'trace')

    expect(result).toEqual([])
  })
})
