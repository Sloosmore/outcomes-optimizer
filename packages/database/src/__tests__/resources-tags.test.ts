/**
 * Unit tests for tag-related behaviour in packages/database/src/resources.ts
 * All DB calls, executeAction, and tag helpers are mocked — no real database connection.
 */

// ── hoist mock fns so factories can reference them ────────────────────────────
const {
  mockGetDb,
  mockIsDatabaseEnabled,
  mockUpsertTag,
  mockAttachTag,
  mockExecuteAction,
  mockCreateClient,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockIsDatabaseEnabled: vi.fn(),
  mockUpsertTag: vi.fn(),
  mockAttachTag: vi.fn(),
  mockExecuteAction: vi.fn(),
  mockCreateClient: vi.fn(),
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

vi.mock('../actions/execute-action.js', () => ({
  executeAction: mockExecuteAction,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
}))

// Import under test AFTER mocks are registered
import { addResource, getResourcesByTag } from '../resources.js'

// ── helpers ───────────────────────────────────────────────────────────────────

const RESOURCE_ID = '11111111-2222-3333-4444-555555555555'
const TAG_ID_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TAG_ID_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const PROJECT_ID = 'cccccccc-dddd-eeee-ffff-000000000000'
const CREATED_AT = new Date('2026-01-01T00:00:00Z')

const mockResource = {
  id: RESOURCE_ID,
  name: 'test-resource',
  type: 'identity',
  status: 'active',
  config: {},
  notes: null,
  lockedBy: null,
  lockedAt: null,
  metadata: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
}

/**
 * Build a mock db that simulates the select chain used after executeAction
 * to retrieve the inserted resource by id:
 *   db.select().from(resources).where(eq(resources.id, id))
 * returning [mockResource].
 */
function makeSelectByIdMock(returnValue: unknown[]) {
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

// ── addResource with tags ─────────────────────────────────────────────────────

describe('addResource with tags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'test-key'
    mockCreateClient.mockReturnValue({})
  })

  it('calls upsertTag and attachTag once per tag', async () => {
    mockExecuteAction.mockResolvedValue({ identityResourceId: RESOURCE_ID })
    const selectMock = makeSelectByIdMock([mockResource])
    mockGetDb.mockReturnValue(selectMock)
    mockUpsertTag
      .mockResolvedValueOnce({ id: TAG_ID_A, name: 'prod', createdAt: CREATED_AT })
      .mockResolvedValueOnce({ id: TAG_ID_B, name: 'instagram', createdAt: CREATED_AT })
    mockAttachTag.mockResolvedValue(undefined)

    await addResource({
      name: 'test-resource',
      type: 'identity',
      tags: ['prod', 'instagram'],
      projectId: PROJECT_ID,
      config: { handle: 'trianglebender' },
    })

    expect(mockUpsertTag).toHaveBeenCalledTimes(2)
    expect(mockUpsertTag).toHaveBeenCalledWith('prod')
    expect(mockUpsertTag).toHaveBeenCalledWith('instagram')
    expect(mockAttachTag).toHaveBeenCalledTimes(2)
    expect(mockAttachTag).toHaveBeenCalledWith(RESOURCE_ID, 'resource', TAG_ID_A)
    expect(mockAttachTag).toHaveBeenCalledWith(RESOURCE_ID, 'resource', TAG_ID_B)
  })

  it('returns the inserted resource', async () => {
    mockExecuteAction.mockResolvedValue({ identityResourceId: RESOURCE_ID })
    const selectMock = makeSelectByIdMock([mockResource])
    mockGetDb.mockReturnValue(selectMock)
    mockUpsertTag.mockResolvedValue({ id: TAG_ID_A, name: 'prod', createdAt: CREATED_AT })
    mockAttachTag.mockResolvedValue(undefined)

    const result = await addResource({
      name: 'test-resource',
      type: 'identity',
      tags: ['prod'],
      projectId: PROJECT_ID,
      config: { handle: 'trianglebender' },
    })

    expect(result).toEqual(mockResource)
  })
})

// ── addResource without tags ──────────────────────────────────────────────────

describe('addResource without tags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'test-key'
    mockCreateClient.mockReturnValue({})
  })

  it('does NOT call upsertTag or attachTag when tags is undefined', async () => {
    mockExecuteAction.mockResolvedValue({ identityResourceId: RESOURCE_ID })
    const selectMock = makeSelectByIdMock([mockResource])
    mockGetDb.mockReturnValue(selectMock)

    await addResource({ name: 'test-resource', type: 'identity', projectId: PROJECT_ID, config: { handle: 'trianglebender' } })

    expect(mockUpsertTag).not.toHaveBeenCalled()
    expect(mockAttachTag).not.toHaveBeenCalled()
  })

  it('does NOT call upsertTag or attachTag when tags is an empty array', async () => {
    mockExecuteAction.mockResolvedValue({ identityResourceId: RESOURCE_ID })
    const selectMock = makeSelectByIdMock([mockResource])
    mockGetDb.mockReturnValue(selectMock)

    await addResource({ name: 'test-resource', type: 'identity', tags: [], projectId: PROJECT_ID, config: { handle: 'trianglebender' } })

    expect(mockUpsertTag).not.toHaveBeenCalled()
    expect(mockAttachTag).not.toHaveBeenCalled()
  })
})

// ── getResourcesByTag ─────────────────────────────────────────────────────────

describe('getResourcesByTag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns mapped resources for a matching tag', async () => {
    const rows = [{ resource: mockResource }]
    const selectMock = makeJoinSelectMock(rows)
    mockGetDb.mockReturnValue(selectMock)

    const result = await getResourcesByTag('prod')

    expect(result).toEqual([mockResource])
    expect(selectMock.select).toHaveBeenCalledOnce()
    expect(selectMock.from).toHaveBeenCalledOnce()
    expect(selectMock.innerJoin1).toHaveBeenCalledOnce()
    expect(selectMock.innerJoin2).toHaveBeenCalledOnce()
    expect(selectMock.where).toHaveBeenCalledOnce()
  })

  it('returns empty array when no resources match the tag', async () => {
    const selectMock = makeJoinSelectMock([])
    mockGetDb.mockReturnValue(selectMock)

    const result = await getResourcesByTag('nonexistent')

    expect(result).toEqual([])
  })
})
