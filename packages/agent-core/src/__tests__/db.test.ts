import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

vi.mock('dotenv/config', () => ({}))

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://mock:mock@localhost/mock'
})

const fakeSql = Object.assign(vi.fn(), { json: (v: unknown) => v })
vi.mock('@skill-networks/database/client', () => ({
  getSqlClient: () => fakeSql,
  closeSqlClient: vi.fn()
}))

import { ResourcesService } from '@skill-networks/database'

describe('ResourcesService.add', () => {
  beforeEach(() => { fakeSql.mockReset() })

  it('inserts and returns the created resource', async () => {
    const mockResource = {
      id: 'abc', name: 'test', type: 'identity', status: 'active',
      config: { platform: 'test' }, notes: null, locked_by: null, locked_at: null,
      created_at: '2024-01-01', updated_at: '2024-01-01'
    }
    fakeSql.mockResolvedValueOnce([mockResource])
    const result = await new ResourcesService(fakeSql).add('test', 'identity', { platform: 'test' })
    expect(result).toEqual(mockResource)
    expect(fakeSql).toHaveBeenCalledOnce()
  })

  it('validates resource name format', async () => {
    await expect(new ResourcesService(fakeSql).add('invalid name!', 'identity')).rejects.toThrow('Invalid resource name')
  })

  it('validates resource type', async () => {
    await expect(new ResourcesService(fakeSql).add('valid-name', 'badtype')).rejects.toThrow('Invalid resource type')
  })

  it('defaults status to active', async () => {
    const mockResource = { id: 'abc', name: 'test', type: 'skill', status: 'active', config: null, notes: null, locked_by: null, locked_at: null, created_at: '2024-01-01', updated_at: '2024-01-01' }
    fakeSql.mockResolvedValueOnce([mockResource])
    const result = await new ResourcesService(fakeSql).add('test', 'skill')
    expect(result).toEqual(mockResource)
  })
})

describe('ResourcesService.createLink', () => {
  beforeEach(() => { fakeSql.mockReset() })

  it('rejects invalid link type', async () => {
    fakeSql.mockResolvedValueOnce([])  // getLinkTypeByName returns empty = null
    await expect(new ResourcesService(fakeSql).createLink('from', 'to', 'badtype')).rejects.toThrow('Invalid link type: badtype')
  })

  it('resolves names to IDs and inserts link', async () => {
    const linkRow = [{ from_id: 'from-uuid', to_id: 'to-uuid', link_type: 'parent', created_at: '2024-01-01' }]
    fakeSql
      .mockResolvedValueOnce([{ name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' }])  // getLinkTypeByName
      .mockResolvedValueOnce([{ id: 'from-uuid', type: 'identity' }])  // resolveResource(fromName)
      .mockResolvedValueOnce([{ id: 'to-uuid', type: 'app' }])         // resolveResource(toName)
      .mockResolvedValueOnce([{ id: 'rule-id', link_type: 'parent', from_type: 'identity', to_type: 'app', created_at: '2024-01-01' }])  // getLinkTypeRules
      .mockResolvedValueOnce(linkRow)  // INSERT ... ON CONFLICT DO NOTHING
    const result = await new ResourcesService(fakeSql).createLink('from-resource', 'to-resource', 'parent')
    expect(result.link.from_id).toBe('from-uuid')
    expect(result.link.link_type).toBe('parent')
    expect(result.created).toBe(true)
  })

  it('throws when from resource not found', async () => {
    fakeSql
      .mockResolvedValueOnce([{ name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' }])  // getLinkTypeByName
      .mockResolvedValueOnce([])  // resolveResource(fromName) empty — Promise.all starts both simultaneously
      .mockResolvedValueOnce([{ id: 'to-uuid', type: 'app' }])  // resolveResource(toName) — consumed in parallel
    await expect(new ResourcesService(fakeSql).createLink('bad-name', 'to', 'parent')).rejects.toThrow('Resource not found: bad-name')
  })

  it('throws when to resource not found', async () => {
    fakeSql
      .mockResolvedValueOnce([{ name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' }])  // getLinkTypeByName
      .mockResolvedValueOnce([{ id: 'from-uuid', type: 'identity' }])  // resolveResource(fromName) ok
      .mockResolvedValueOnce([])  // resolveResource(toName) empty
    await expect(new ResourcesService(fakeSql).createLink('from', 'bad-to', 'parent')).rejects.toThrow('Resource not found: bad-to')
  })

  it('returns existing row and created=false when ON CONFLICT DO NOTHING fires', async () => {
    const existingLink = { from_id: 'f', to_id: 't', link_type: 'parent', created_at: '2024-01-01' }
    fakeSql
      .mockResolvedValueOnce([{ name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' }])  // getLinkTypeByName
      .mockResolvedValueOnce([{ id: 'f', type: 'identity' }])  // resolveResource(fromName)
      .mockResolvedValueOnce([{ id: 't', type: 'app' }])       // resolveResource(toName)
      .mockResolvedValueOnce([{ id: 'rule-id', link_type: 'parent', from_type: 'identity', to_type: 'app', created_at: '2024-01-01' }])  // getLinkTypeRules
      .mockResolvedValueOnce([])  // INSERT returns empty (conflict)
      .mockResolvedValueOnce([existingLink])  // SELECT existing
    const result = await new ResourcesService(fakeSql).createLink('from', 'to', 'parent')
    expect(result.link).toEqual(existingLink)
    expect(result.created).toBe(false)
  })

  it('rejects invalid type pairing', async () => {
    fakeSql
      .mockResolvedValueOnce([{ name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' }])  // getLinkTypeByName
      .mockResolvedValueOnce([{ id: 'app-uuid', type: 'app' }])        // resolveResource(fromName) - app type
      .mockResolvedValueOnce([{ id: 'id-uuid', type: 'identity' }])    // resolveResource(toName) - identity type
      .mockResolvedValueOnce([{ id: 'rule-id', link_type: 'parent', from_type: 'identity', to_type: 'app', created_at: '2024-01-01' }])  // getLinkTypeRules - rule is identity→app, not app→identity
    await expect(new ResourcesService(fakeSql).createLink('meta-app', 'instagram-squarebent', 'parent')).rejects.toThrow("app → identity does not match any rule for type 'parent'")
  })

  it('rejects when link type has no rules defined', async () => {
    fakeSql
      .mockResolvedValueOnce([{ name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' }])  // getLinkTypeByName
      .mockResolvedValueOnce([{ id: 'from-uuid', type: 'identity' }])  // resolveResource(fromName)
      .mockResolvedValueOnce([{ id: 'to-uuid', type: 'app' }])         // resolveResource(toName)
      .mockResolvedValueOnce([])  // getLinkTypeRules returns empty
    await expect(new ResourcesService(fakeSql).createLink('from', 'to', 'parent')).rejects.toThrow("Link type 'parent' has no rules defined")
  })

  it('allows any pairing when rule has null from/to types (wildcard)', async () => {
    fakeSql
      .mockResolvedValueOnce([{ name: 'grants', description: 'Resource grants access or permissions to another', cardinality: 'many-to-many', created_at: '2024-01-01' }])
      .mockResolvedValueOnce([{ id: 'from-uuid', type: 'identity' }])
      .mockResolvedValueOnce([{ id: 'to-uuid', type: 'identity' }])
      .mockResolvedValueOnce([{ id: 'rule-id', link_type: 'grants', from_type: null, to_type: null, created_at: '2024-01-01' }])
      .mockResolvedValueOnce([{ from_id: 'from-uuid', to_id: 'to-uuid', link_type: 'grants', created_at: '2024-01-01' }])
    const result = await new ResourcesService(fakeSql).createLink('from', 'to', 'grants')
    expect(result.created).toBe(true)
  })
})

describe('ResourcesService.deleteLink', () => {
  beforeEach(() => { fakeSql.mockReset() })

  it('rejects invalid link type', async () => {
    fakeSql.mockResolvedValueOnce([])  // getLinkTypeByName returns empty = null
    await expect(new ResourcesService(fakeSql).deleteLink('from', 'to', 'badtype')).rejects.toThrow('Invalid link type')
  })

  it('deletes the link successfully', async () => {
    fakeSql
      .mockResolvedValueOnce([{ name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' }])  // getLinkTypeByName
      .mockResolvedValueOnce([{ id: 'f' }])  // resolveResourceId(fromName)
      .mockResolvedValueOnce([{ id: 't' }])  // resolveResourceId(toName)
      .mockResolvedValueOnce(Object.assign([], { count: 1 }))  // DELETE
    await expect(new ResourcesService(fakeSql).deleteLink('from', 'to', 'parent')).resolves.toBeUndefined()
  })

  it('throws when no rows deleted', async () => {
    fakeSql
      .mockResolvedValueOnce([{ name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' }])  // getLinkTypeByName
      .mockResolvedValueOnce([{ id: 'f' }])  // resolveResourceId(fromName)
      .mockResolvedValueOnce([{ id: 't' }])  // resolveResourceId(toName)
      .mockResolvedValueOnce(Object.assign([], { count: 0 }))  // DELETE
    await expect(new ResourcesService(fakeSql).deleteLink('from', 'to', 'parent')).rejects.toThrow('Link not found')
  })
})

describe('ResourcesService.getLinkTypes', () => {
  beforeEach(() => { fakeSql.mockReset() })

  it('returns all link types ordered by name', async () => {
    const mockTypes = [
      { name: 'credential', description: 'Resource authenticates via this credential', cardinality: 'many-to-one', created_at: '2024-01-01' },
      { name: 'dependsOn', description: 'This resource cannot start or proceed until the target resource is complete', cardinality: 'many-to-many', created_at: '2024-01-01' },
      { name: 'parent', description: 'Resource belongs to a parent resource', cardinality: 'many-to-one', created_at: '2024-01-01' },
      { name: 'proxy', description: 'Resource egresses through this proxy', cardinality: 'many-to-one', created_at: '2024-01-01' },
    ]
    fakeSql.mockResolvedValueOnce(mockTypes)
    const result = await new ResourcesService(fakeSql).getLinkTypes()
    expect(result).toEqual(mockTypes)
    expect(result).toHaveLength(4)
  })

  it('returns empty array when no link types exist', async () => {
    fakeSql.mockResolvedValueOnce([])
    const result = await new ResourcesService(fakeSql).getLinkTypes()
    expect(result).toEqual([])
  })
})

describe('ResourcesService.getLinkTypeByName', () => {
  beforeEach(() => { fakeSql.mockReset() })

  it('returns a single link type by name', async () => {
    const mockType = { name: 'credential', description: 'Resource authenticates via this credential', cardinality: 'many-to-one', created_at: '2024-01-01' }
    fakeSql.mockResolvedValueOnce([mockType])
    const result = await new ResourcesService(fakeSql).getLinkTypeByName('credential')
    expect(result).toEqual(mockType)
  })

  it('returns null for unknown link type', async () => {
    fakeSql.mockResolvedValueOnce([])
    const result = await new ResourcesService(fakeSql).getLinkTypeByName('unknown')
    expect(result).toBeNull()
  })
})

describe('ResourcesService.getLinkTypeRules', () => {
  beforeEach(() => { fakeSql.mockReset() })

  it('returns all rules when no filter provided', async () => {
    const mockRules = [
      { id: '1', link_type: 'credential', from_type: 'identity', to_type: 'credential', created_at: '2024-01-01' },
      { id: '2', link_type: 'dependsOn', from_type: 'skill', to_type: 'skill', created_at: '2024-01-01' },
      { id: '3', link_type: 'parent', from_type: 'identity', to_type: 'app', created_at: '2024-01-01' },
      { id: '4', link_type: 'proxy', from_type: 'identity', to_type: 'proxy', created_at: '2024-01-01' },
    ]
    fakeSql.mockResolvedValueOnce(mockRules)
    const result = await new ResourcesService(fakeSql).getLinkTypeRules()
    expect(result).toEqual(mockRules)
    expect(result).toHaveLength(4)
  })

  it('filters by link type when provided', async () => {
    const mockRules = [
      { id: '3', link_type: 'parent', from_type: 'identity', to_type: 'app', created_at: '2024-01-01' },
    ]
    fakeSql.mockResolvedValueOnce(mockRules)
    const result = await new ResourcesService(fakeSql).getLinkTypeRules({ linkType: 'parent' })
    expect(result).toEqual(mockRules)
    expect(result).toHaveLength(1)
  })

  it('returns empty array when no rules match filter', async () => {
    fakeSql.mockResolvedValueOnce([])
    const result = await new ResourcesService(fakeSql).getLinkTypeRules({ linkType: 'nonexistent' })
    expect(result).toEqual([])
  })

  it('handles rules with null from_type and to_type', async () => {
    const mockRules = [
      { id: '2', link_type: 'grants', from_type: null, to_type: null, created_at: '2024-01-01' },
    ]
    fakeSql.mockResolvedValueOnce(mockRules)
    const result = await new ResourcesService(fakeSql).getLinkTypeRules({ linkType: 'grants' })
    expect(result).toHaveLength(1)
    expect(result[0].from_type).toBeNull()
    expect(result[0].to_type).toBeNull()
  })
})
