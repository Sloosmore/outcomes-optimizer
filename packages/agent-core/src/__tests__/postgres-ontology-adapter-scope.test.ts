import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

vi.mock('dotenv/config', () => ({}))

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://mock:mock@localhost/mock'
})

const fakeSql = Object.assign(vi.fn(), { json: (v: unknown) => v })
vi.mock('@skill-networks/database/client', () => ({
  getSqlClient: () => fakeSql,
  closeSqlClient: vi.fn(),
}))

// Mock the service constructors so we can control what each method returns
// without touching a real database.
const mockResourcesList = vi.fn()
const mockResourcesSearch = vi.fn()
const mockResourcesGetByName = vi.fn()
const mockResourcesGetById = vi.fn()
const mockResourcesGetAvailable = vi.fn()
const mockResourcesGetTypes = vi.fn()
const mockResourcesGetLinkTypes = vi.fn()
const mockResourcesGetValueTypes = vi.fn()
const mockResourcesListAllLinks = vi.fn()

const mockProcessesListLeaves = vi.fn()
const mockProcessesGetById = vi.fn()
const mockProcessesGetByName = vi.fn()

vi.mock('@skill-networks/database', () => {
  class ResourcesService {
    list = mockResourcesList
    search = mockResourcesSearch
    getByName = mockResourcesGetByName
    getById = mockResourcesGetById
    getAvailable = mockResourcesGetAvailable
    getTypes = mockResourcesGetTypes
    getLinkTypes = mockResourcesGetLinkTypes
    getValueTypes = mockResourcesGetValueTypes
    listAllLinks = mockResourcesListAllLinks
  }
  class ProcessesService {
    listLeaves = mockProcessesListLeaves
    getById = mockProcessesGetById
    getByName = mockProcessesGetByName
  }
  class MetricsService {}
  return { ResourcesService, ProcessesService, MetricsService }
})

import { PostgresOntologyAdapter } from '../adapters/postgres-ontology-adapter.js'
import type { ProjectScope } from '@skill-networks/database/services'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ProjectScope that only admits the given resource IDs. */
function makeScope(resourceIds: string[], projectIds: string[] = []): ProjectScope {
  const rSet = new Set(resourceIds)
  const pSet = new Set(projectIds)
  return {
    resourceIds: rSet,
    projectIds: pSet,
    has(id: string) { return rSet.has(id) },
    filterResources<T extends { id: string }>(rows: T[]): T[] {
      return rows.filter(r => rSet.has(r.id))
    },
    filterLinks<T extends { from_id: string; to_id: string }>(links: T[]): T[] {
      return links.filter(l => rSet.has(l.from_id) && rSet.has(l.to_id))
    },
    filterProcesses<T extends { project_id: string | null }>(rows: T[]): T[] {
      return rows.filter(r => r.project_id !== null && pSet.has(r.project_id))
    },
  }
}

// Sample data reused across tests
const RESOURCE_A = { id: 'res-a', name: 'alpha', type: 'skill', status: 'active', config: null, notes: null, locked_by: null, locked_at: null, created_at: '2024-01-01', updated_at: '2024-01-01' }
const RESOURCE_B = { id: 'res-b', name: 'beta', type: 'skill', status: 'active', config: null, notes: null, locked_by: null, locked_at: null, created_at: '2024-01-01', updated_at: '2024-01-01' }
const RESOURCE_C = { id: 'res-c', name: 'gamma', type: 'skill', status: 'active', config: null, notes: null, locked_by: null, locked_at: null, created_at: '2024-01-01', updated_at: '2024-01-01' }

const LINK_AB = { from_id: 'res-a', to_id: 'res-b', link_type: 'parent', created_at: '2024-01-01' }
const LINK_AC = { from_id: 'res-a', to_id: 'res-c', link_type: 'parent', created_at: '2024-01-01' }
const LINK_BC = { from_id: 'res-b', to_id: 'res-c', link_type: 'runs', created_at: '2024-01-01' }

const PROC_P1 = { id: 'proc-1', name: 'run-1', project_id: 'proj-1', status: 'active', root_process_id: 'proc-1', parent_process_id: null, resume_at: null, created_at: '2024-01-01', updated_at: '2024-01-01' }
const PROC_P2 = { id: 'proc-2', name: 'run-2', project_id: 'proj-2', status: 'active', root_process_id: 'proc-2', parent_process_id: null, resume_at: null, created_at: '2024-01-01', updated_at: '2024-01-01' }
const PROC_NULL = { id: 'proc-3', name: 'run-3', project_id: null, status: 'active', root_process_id: 'proc-3', parent_process_id: null, resume_at: null, created_at: '2024-01-01', updated_at: '2024-01-01' }

// ---------------------------------------------------------------------------
// (a) listResources() — scoped
// ---------------------------------------------------------------------------

describe('PostgresOntologyAdapter.listResources — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns only resources whose id is in scope.resourceIds', async () => {
    mockResourcesList.mockResolvedValueOnce([RESOURCE_A, RESOURCE_B, RESOURCE_C])

    const scope = makeScope(['res-a', 'res-b'])
    // Story 2 will add: new PostgresOntologyAdapter({ scope })
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.listResources()

    expect(result).toHaveLength(2)
    expect(result.map(r => r.id)).toEqual(expect.arrayContaining(['res-a', 'res-b']))
    expect(result.map(r => r.id)).not.toContain('res-c')
  })

  it('returns empty array when no resources fall within scope', async () => {
    mockResourcesList.mockResolvedValueOnce([RESOURCE_A, RESOURCE_B])

    const scope = makeScope(['res-z'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.listResources()

    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (b) listAllResourceLinks() — scoped
// ---------------------------------------------------------------------------

describe('PostgresOntologyAdapter.listAllResourceLinks — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns only links where both from_id and to_id are in scope', async () => {
    mockResourcesListAllLinks.mockResolvedValueOnce([LINK_AB, LINK_AC, LINK_BC])

    // scope = {res-a, res-b} — LINK_AC (a→c) and LINK_BC (b→c) should be excluded
    const scope = makeScope(['res-a', 'res-b'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.listAllResourceLinks()

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(LINK_AB)
  })

  it('returns empty array when no links have both endpoints in scope', async () => {
    mockResourcesListAllLinks.mockResolvedValueOnce([LINK_AB, LINK_AC])

    const scope = makeScope(['res-c'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.listAllResourceLinks()

    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (c) listProcesses() — scoped
// ---------------------------------------------------------------------------

describe('PostgresOntologyAdapter.listProcesses — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns only processes whose project_id is in scope.projectIds', async () => {
    mockProcessesListLeaves.mockResolvedValueOnce([PROC_P1, PROC_P2, PROC_NULL])

    const scope = makeScope([], ['proj-1'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.listProcesses()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('proc-1')
  })

  it('excludes processes with null project_id even when scope is broad', async () => {
    mockProcessesListLeaves.mockResolvedValueOnce([PROC_P1, PROC_NULL])

    const scope = makeScope([], ['proj-1', 'proj-2'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.listProcesses()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('proc-1')
  })
})

// ---------------------------------------------------------------------------
// (d) searchResources / getResource / getResourceById / getAvailableResources
//     — scoped via filterResources()
// ---------------------------------------------------------------------------

describe('PostgresOntologyAdapter.searchResources — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('filters search results through scope.filterResources', async () => {
    mockResourcesSearch.mockResolvedValueOnce([RESOURCE_A, RESOURCE_B, RESOURCE_C])

    const scope = makeScope(['res-a'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.searchResources('alpha')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('res-a')
  })
})

describe('PostgresOntologyAdapter.getResource — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns null when the resource exists but is outside scope', async () => {
    mockResourcesGetByName.mockResolvedValueOnce(RESOURCE_C)

    const scope = makeScope(['res-a', 'res-b'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getResource('gamma')

    expect(result).toBeNull()
  })

  it('returns the resource when it is within scope', async () => {
    mockResourcesGetByName.mockResolvedValueOnce(RESOURCE_A)

    const scope = makeScope(['res-a'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getResource('alpha')

    expect(result).toEqual(RESOURCE_A)
  })
})

describe('PostgresOntologyAdapter.getResourceById — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns null when the id is outside scope (ID access respects scope)', async () => {
    mockResourcesGetById.mockResolvedValueOnce(RESOURCE_C)

    const scope = makeScope(['res-a'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getResourceById('res-c')

    // ID-based access respects scope: out-of-scope resources return null
    expect(result).toBeNull()
  })

  it('returns the resource when the id is within scope', async () => {
    mockResourcesGetById.mockResolvedValueOnce(RESOURCE_A)

    const scope = makeScope(['res-a'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getResourceById('res-a')

    expect(result).toEqual(RESOURCE_A)
  })
})

describe('PostgresOntologyAdapter.getAvailableResources — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns only in-scope resources from getAvailableResources', async () => {
    mockResourcesGetAvailable.mockResolvedValueOnce([RESOURCE_A, RESOURCE_B])

    const scope = makeScope(['res-b'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getAvailableResources('skill')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('res-b')
  })
})

// ---------------------------------------------------------------------------
// (e) Configuration methods — NOT filtered regardless of scope
// ---------------------------------------------------------------------------

describe('PostgresOntologyAdapter configuration methods — unaffected by scope', () => {
  const MOCK_RESOURCE_TYPES = [{ name: 'skill', description: 'A skill', created_at: '2024-01-01' }]
  const MOCK_LINK_TYPES = [{ name: 'parent', description: 'Parent link', cardinality: 'many-to-one', created_at: '2024-01-01' }]
  const MOCK_VALUE_TYPES = [{ name: 'text', description: 'Text value', created_at: '2024-01-01' }]

  beforeEach(() => { vi.clearAllMocks() })

  it('getResourceTypes returns all types regardless of scope', async () => {
    mockResourcesGetTypes.mockResolvedValueOnce(MOCK_RESOURCE_TYPES)

    const scope = makeScope([]) // empty scope — nothing passes
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getResourceTypes()

    expect(result).toEqual(MOCK_RESOURCE_TYPES)
  })

  it('getLinkTypes returns all link types regardless of scope', async () => {
    mockResourcesGetLinkTypes.mockResolvedValueOnce(MOCK_LINK_TYPES)

    const scope = makeScope([])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getLinkTypes()

    expect(result).toEqual(MOCK_LINK_TYPES)
  })

  it('getValueTypes returns all value types regardless of scope', async () => {
    mockResourcesGetValueTypes.mockResolvedValueOnce(MOCK_VALUE_TYPES)

    const scope = makeScope([])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getValueTypes()

    expect(result).toEqual(MOCK_VALUE_TYPES)
  })
})

// ---------------------------------------------------------------------------
// (f) Without scope — all methods return unfiltered results
// ---------------------------------------------------------------------------

describe('PostgresOntologyAdapter — without scope (unfiltered)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('listResources returns all rows when no scope is provided', async () => {
    mockResourcesList.mockResolvedValueOnce([RESOURCE_A, RESOURCE_B, RESOURCE_C])

    const adapter = new PostgresOntologyAdapter()

    const result = await adapter.listResources()

    expect(result).toHaveLength(3)
  })

  it('listAllResourceLinks returns all links when no scope is provided', async () => {
    mockResourcesListAllLinks.mockResolvedValueOnce([LINK_AB, LINK_AC, LINK_BC])

    const adapter = new PostgresOntologyAdapter()

    const result = await adapter.listAllResourceLinks()

    expect(result).toHaveLength(3)
  })

  it('listProcesses returns all processes when no scope is provided', async () => {
    mockProcessesListLeaves.mockResolvedValueOnce([PROC_P1, PROC_P2, PROC_NULL])

    const adapter = new PostgresOntologyAdapter()

    const result = await adapter.listProcesses()

    expect(result).toHaveLength(3)
  })

  it('searchResources returns all matching rows when no scope is provided', async () => {
    mockResourcesSearch.mockResolvedValueOnce([RESOURCE_A, RESOURCE_B])

    const adapter = new PostgresOntologyAdapter()

    const result = await adapter.searchResources('a')

    expect(result).toHaveLength(2)
  })

  it('getResource returns the resource when no scope is provided', async () => {
    mockResourcesGetByName.mockResolvedValueOnce(RESOURCE_C)

    const adapter = new PostgresOntologyAdapter()

    const result = await adapter.getResource('gamma')

    expect(result).toEqual(RESOURCE_C)
  })

  it('getResourceById returns the resource when no scope is provided', async () => {
    mockResourcesGetById.mockResolvedValueOnce(RESOURCE_C)

    const adapter = new PostgresOntologyAdapter()

    const result = await adapter.getResourceById('res-c')

    expect(result).toEqual(RESOURCE_C)
  })

  it('getAvailableResources returns all matching rows when no scope is provided', async () => {
    mockResourcesGetAvailable.mockResolvedValueOnce([RESOURCE_A, RESOURCE_B])

    const adapter = new PostgresOntologyAdapter()

    const result = await adapter.getAvailableResources('skill')

    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// (g) getProcessById() — scoped
// ---------------------------------------------------------------------------

describe('PostgresOntologyAdapter.getProcessById — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns null when process project_id is out of scope', async () => {
    mockProcessesGetById.mockResolvedValueOnce(PROC_P2) // project_id: 'proj-2'

    const scope = makeScope([], ['proj-1']) // only proj-1 in scope
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getProcessById('proc-2')

    expect(result).toBeNull()
  })

  it('returns process when project_id is in scope', async () => {
    mockProcessesGetById.mockResolvedValueOnce(PROC_P1) // project_id: 'proj-1'

    const scope = makeScope([], ['proj-1'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getProcessById('proc-1')

    expect(result).toEqual(PROC_P1)
  })

  it('returns null when getById returns null (no scope check needed)', async () => {
    mockProcessesGetById.mockResolvedValueOnce(null)

    const scope = makeScope([], ['proj-1'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getProcessById('proc-nonexistent')

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (h) getProcessByName() — scoped
// ---------------------------------------------------------------------------

describe('PostgresOntologyAdapter.getProcessByName — with scope', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns null when all matching processes are out of scope', async () => {
    // getByName returns two processes, both with project_id outside scope
    mockProcessesGetByName.mockResolvedValueOnce([PROC_P2, PROC_P1]) // proj-2, proj-1

    const scope = makeScope([], []) // empty scope — nothing admitted
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getProcessByName('run-1')

    expect(result).toBeNull()
  })

  it('returns the latest in-scope process when multiple share a name across projects', async () => {
    // getByName returns newest-first: PROC_P2 (proj-2) then PROC_P1 (proj-1)
    mockProcessesGetByName.mockResolvedValueOnce([PROC_P2, PROC_P1])

    const scope = makeScope([], ['proj-1']) // only proj-1 in scope
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getProcessByName('run-1')

    // PROC_P2 is newer but out of scope; PROC_P1 is oldest in-scope match
    expect(result).not.toBeNull()
    expect(result!.id).toBe('proc-1')
  })

  it('returns null when getByName returns empty array', async () => {
    mockProcessesGetByName.mockResolvedValueOnce([])

    const scope = makeScope([], ['proj-1'])
    const adapter = new PostgresOntologyAdapter({ scope })

    const result = await adapter.getProcessByName('nonexistent')

    expect(result).toBeNull()
  })

  it('returns first result without scope filtering when no scope is set', async () => {
    mockProcessesGetByName.mockResolvedValueOnce([PROC_P1, PROC_P2])

    const adapter = new PostgresOntologyAdapter() // no scope

    const result = await adapter.getProcessByName('run-1')

    expect(result).toEqual(PROC_P1) // first element returned as-is
  })
})
