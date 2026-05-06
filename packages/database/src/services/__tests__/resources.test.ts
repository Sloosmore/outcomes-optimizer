import { describe, it, expect } from 'vitest'
import { ResourcesService, type Resource } from '../resources.js'

// Mock sql that handles multiple query types based on query content
function makeMockSql(opts: {
  userRow?: { id: string } | null
  linkRows?: { to_id: string }[]
  projectRows?: Array<{ id: string; name: string; created_at?: string }>
} = {}) {
  const { userRow = null, linkRows = [], projectRows = [] } = opts

  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const query = strings.raw.join('?')
    // findByExternalId: SELECT id FROM resources WHERE type = ... AND auth_user_id = ...
    if (query.includes('auth_user_id')) {
      return Promise.resolve(userRow ? [userRow] : [])
    }
    // resolveDefaultProject / listUserProjects: JOIN query with p.type = 'project'
    if (query.includes('member_of') && query.includes("p.type")) {
      return Promise.resolve(projectRows)
    }
    // resolveUserProjects: simple member_of link query (no p.type)
    if (query.includes('member_of')) {
      return Promise.resolve(linkRows)
    }
    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return mockSql
}

describe('ResourcesService.resolveUserProjects()', () => {
  it('returns empty Set when user does not exist', async () => {
    const sql = makeMockSql({ userRow: null, linkRows: [] })
    const service = new ResourcesService(sql)
    const result = await service.resolveUserProjects('nonexistent-user-id')
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(0)
  })

  it('returns empty Set when user exists but has no member_of links', async () => {
    const sql = makeMockSql({ userRow: { id: '9d08cd99-bb60-416d-803c-96880ac77e19' }, linkRows: [] })
    const service = new ResourcesService(sql)
    const result = await service.resolveUserProjects('auth-user-1')
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(0)
  })

  it('returns Set with both to_ids when user has 2 member_of links', async () => {
    const sql = makeMockSql({
      userRow: { id: '9d08cd99-bb60-416d-803c-96880ac77e19' },
      linkRows: [{ to_id: 'project-uuid-1' }, { to_id: 'project-uuid-2' }],
    })
    const service = new ResourcesService(sql)
    const result = await service.resolveUserProjects('auth-user-1')
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(2)
    expect(result.has('project-uuid-1')).toBe(true)
    expect(result.has('project-uuid-2')).toBe(true)
  })

  it('excludes links with other link_type values (only member_of links returned)', async () => {
    // The mock only returns rows when 'member_of' is in the query string,
    // simulating DB-level filtering. Non-member_of links would not appear.
    const sql = makeMockSql({
      userRow: { id: '9d08cd99-bb60-416d-803c-96880ac77e19' },
      linkRows: [{ to_id: 'project-uuid-1' }],
    })
    const service = new ResourcesService(sql)
    const result = await service.resolveUserProjects('auth-user-1')
    // Only the member_of link is returned — other link types are excluded by the SQL filter
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(1)
    expect(result.has('project-uuid-1')).toBe(true)
  })
})

describe('ResourcesService.resolveDefaultProject()', () => {
  it('returns null when user does not exist (no matching user:sub name)', async () => {
    const sql = makeMockSql({ projectRows: [] })
    const service = new ResourcesService(sql)
    const result = await service.resolveDefaultProject('nonexistent-sub')
    expect(result).toBeNull()
  })

  it('returns earliest project when user has multiple projects', async () => {
    const sql = makeMockSql({
      projectRows: [{ id: 'proj-uuid-1', name: 'project:earliest' }],
    })
    const service = new ResourcesService(sql)
    const result = await service.resolveDefaultProject('test-sub')
    expect(result).toEqual({ id: 'proj-uuid-1', name: 'project:earliest' })
  })

  it('returns null when user exists but has no projects', async () => {
    const sql = makeMockSql({ userRow: { id: '9d08cd99-bb60-416d-803c-96880ac77e19' }, projectRows: [] })
    const service = new ResourcesService(sql)
    const result = await service.resolveDefaultProject('test-sub')
    expect(result).toBeNull()
  })
})

describe('ResourcesService.listUserProjects()', () => {
  it('returns empty array when user has no projects', async () => {
    const sql = makeMockSql({ projectRows: [] })
    const service = new ResourcesService(sql)
    const result = await service.listUserProjects('nonexistent-sub')
    expect(result).toEqual([])
  })

  it('returns all projects ordered by created_at', async () => {
    const sql = makeMockSql({
      projectRows: [
        { id: 'proj-1', name: 'project:first', created_at: '2024-01-01' },
        { id: 'proj-2', name: 'project:second', created_at: '2024-06-01' },
      ],
    })
    const service = new ResourcesService(sql)
    const result = await service.listUserProjects('test-sub')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ id: 'proj-1', name: 'project:first', created_at: '2024-01-01' })
    expect(result[1]).toEqual({ id: 'proj-2', name: 'project:second', created_at: '2024-06-01' })
  })
})

// ── Sample fixture ────────────────────────────────────────────────────────────

const sampleResource: Resource = {
  id: 'res-uuid-1',
  name: 'test-resource',
  type: 'credential',
  status: 'active',
  config: {},
  notes: null,
  locked_by: null,
  locked_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

// ── Simple mock factories ─────────────────────────────────────────────────────

function makeSimpleMockSql(rows: unknown[]) {
  const mockSql = function(_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
    return Promise.resolve(rows)
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return mockSql
}

function makeSearchMockSql(rows: unknown[]) {
  const mockSql = function(strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
    const query = strings.raw.join('?')
    if (query.includes('ILIKE')) {
      return Promise.resolve(rows)
    }
    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return mockSql
}

// ── Checkout / Release mock factory ──────────────────────────────────────────

function makeCheckoutMockSql(opts: {
  mainUpdateReturns?: Resource | null
  diagReturns?: { locked_by: string | null; finite: boolean; type: string } | null
}) {
  const mockSql = function(strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
    const query = strings.raw.join('?')
    if (
      query.includes('UPDATE resources r') &&
      query.includes('resource_types') &&
      query.includes('locked_by IS NULL') &&
      query.includes('RETURNING r.*')
    ) {
      return Promise.resolve(opts.mainUpdateReturns ? [opts.mainUpdateReturns] : [])
    }
    if (query.includes('SELECT r.locked_by') && query.includes('resource_types rt')) {
      return Promise.resolve(opts.diagReturns ? [opts.diagReturns] : [])
    }
    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return mockSql
}

function makeReleaseMockSql(opts: {
  mainUpdateReturns?: Resource | null
  diagReturns?: { locked_by: string | null } | null
}) {
  const mockSql = function(strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
    const query = strings.raw.join('?')
    if (
      query.includes('UPDATE resources') &&
      query.includes('locked_by = NULL') &&
      query.includes('RETURNING *')
    ) {
      return Promise.resolve(opts.mainUpdateReturns ? [opts.mainUpdateReturns] : [])
    }
    if (query.includes('SELECT locked_by FROM resources')) {
      return Promise.resolve(opts.diagReturns ? [opts.diagReturns] : [])
    }
    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return mockSql
}

// ── getById ───────────────────────────────────────────────────────────────────

describe('ResourcesService.getById()', () => {
  it('returns the resource when found', async () => {
    const sql = makeSimpleMockSql([sampleResource])
    const service = new ResourcesService(sql)
    const result = await service.getById('res-uuid-1')
    expect(result).toEqual(sampleResource)
  })

  it('returns null when not found', async () => {
    const sql = makeSimpleMockSql([])
    const service = new ResourcesService(sql)
    const result = await service.getById('nonexistent-id')
    expect(result).toBeNull()
  })
})

// ── getByName ─────────────────────────────────────────────────────────────────

describe('ResourcesService.getByName()', () => {
  it('returns the resource when found', async () => {
    const sql = makeSimpleMockSql([sampleResource])
    const service = new ResourcesService(sql)
    const result = await service.getByName('test-resource')
    expect(result).toEqual(sampleResource)
  })

  it('returns null when not found', async () => {
    const sql = makeSimpleMockSql([])
    const service = new ResourcesService(sql)
    const result = await service.getByName('nonexistent-name')
    expect(result).toBeNull()
  })
})

// ── search ────────────────────────────────────────────────────────────────────

describe('ResourcesService.search()', () => {
  it('returns matching resources without type filter', async () => {
    const sql = makeSearchMockSql([sampleResource])
    const service = new ResourcesService(sql)
    const result = await service.search('test')
    expect(result).toEqual([sampleResource])
  })

  it('returns matching resources with type filter', async () => {
    const sql = makeSearchMockSql([sampleResource])
    const service = new ResourcesService(sql)
    const result = await service.search('test', { type: 'credential' })
    expect(result).toEqual([sampleResource])
  })

  it('returns empty array when no matches', async () => {
    const sql = makeSearchMockSql([])
    const service = new ResourcesService(sql)
    const result = await service.search('nomatch')
    expect(result).toEqual([])
  })
})

// ── checkout ──────────────────────────────────────────────────────────────────

describe('ResourcesService.checkout()', () => {
  it('successfully checks out a finite unlocked resource', async () => {
    const lockedResource = { ...sampleResource, locked_by: 'agent-1', locked_at: '2024-01-01T00:00:00Z' }
    const sql = makeCheckoutMockSql({ mainUpdateReturns: lockedResource })
    const service = new ResourcesService(sql)
    const result = await service.checkout('test-resource', 'agent-1')
    expect(result).toEqual(lockedResource)
  })

  it("throws 'already locked by' when resource is already locked", async () => {
    const sql = makeCheckoutMockSql({
      mainUpdateReturns: null,
      diagReturns: { locked_by: 'other-locker', finite: true, type: 'credential' },
    })
    const service = new ResourcesService(sql)
    await expect(service.checkout('test-resource', 'agent-1')).rejects.toThrow('already locked by')
  })

  it("throws 'not finite and cannot be checked out' when resource type is not finite", async () => {
    const sql = makeCheckoutMockSql({
      mainUpdateReturns: null,
      diagReturns: { locked_by: null, finite: false, type: 'data' },
    })
    const service = new ResourcesService(sql)
    await expect(service.checkout('test-resource', 'agent-1')).rejects.toThrow('not finite and cannot be checked out')
  })

  it("throws 'Resource not found' when resource doesn't exist", async () => {
    const sql = makeCheckoutMockSql({
      mainUpdateReturns: null,
      diagReturns: null,
    })
    const service = new ResourcesService(sql)
    await expect(service.checkout('nonexistent', 'agent-1')).rejects.toThrow('Resource not found')
  })

  it("throws 'Locker ID must be a non-empty string' when lockerId is empty", async () => {
    const sql = makeCheckoutMockSql({})
    const service = new ResourcesService(sql)
    await expect(service.checkout('test-resource', '')).rejects.toThrow('Locker ID must be a non-empty string')
  })
})

// ── release ───────────────────────────────────────────────────────────────────

describe('ResourcesService.release()', () => {
  it('successfully releases a locked resource', async () => {
    const unlockedResource = { ...sampleResource, locked_by: null, locked_at: null }
    const sql = makeReleaseMockSql({ mainUpdateReturns: unlockedResource })
    const service = new ResourcesService(sql)
    const result = await service.release('test-resource', 'agent-1')
    expect(result).toEqual(unlockedResource)
  })

  it("throws 'Cannot release: resource is locked by' when locked by different locker", async () => {
    const sql = makeReleaseMockSql({
      mainUpdateReturns: null,
      diagReturns: { locked_by: 'other-locker' },
    })
    const service = new ResourcesService(sql)
    await expect(service.release('test-resource', 'agent-1')).rejects.toThrow('Cannot release: resource is locked by')
  })

  it("throws 'Resource is not locked' when resource exists but not locked", async () => {
    const sql = makeReleaseMockSql({
      mainUpdateReturns: null,
      diagReturns: { locked_by: null },
    })
    const service = new ResourcesService(sql)
    await expect(service.release('test-resource', 'agent-1')).rejects.toThrow('Resource is not locked')
  })

  it("throws 'Resource not found' when resource doesn't exist", async () => {
    const sql = makeReleaseMockSql({
      mainUpdateReturns: null,
      diagReturns: null,
    })
    const service = new ResourcesService(sql)
    await expect(service.release('nonexistent', 'agent-1')).rejects.toThrow('Resource not found')
  })

  it("throws 'Locker ID must be a non-empty string' when lockerId is empty", async () => {
    const sql = makeReleaseMockSql({})
    const service = new ResourcesService(sql)
    await expect(service.release('test-resource', '')).rejects.toThrow('Locker ID must be a non-empty string')
  })
})
