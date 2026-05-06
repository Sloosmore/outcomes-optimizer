import { describe, it, expect, vi } from 'vitest'
import { ProjectScopeService } from '../project-scope.js'

/**
 * These tests verify the ProjectScopeService contract: given a set of root IDs,
 * it calls the resolve_project_scope RPC and returns a ProjectScope with the
 * correct filtering behavior.
 *
 * The actual traversal logic lives in the DB function (resolve_project_scope).
 * These tests mock the sql client to verify the service wiring, not the BFS.
 */

function makeMockSql(returnedIds: string[]) {
  const rows = returnedIds.map(id => ({ resource_id: id }))
  // Tagged template function that returns the rows
  const sql = (() => Promise.resolve(rows)) as any
  sql.end = vi.fn()
  return sql
}

describe('ProjectScopeService.resolve()', () => {
  it('returns scope with all IDs from RPC result', async () => {
    const sql = makeMockSql(['root', 'child1', 'child2'])
    const service = new ProjectScopeService(sql)
    const scope = await service.resolve({ roots: ['root'] })

    expect(scope.resourceIds.has('root')).toBe(true)
    expect(scope.resourceIds.has('child1')).toBe(true)
    expect(scope.resourceIds.has('child2')).toBe(true)
    expect(scope.resourceIds.size).toBe(3)
  })

  it('filterResources keeps only in-scope resources', async () => {
    const sql = makeMockSql(['a', 'b'])
    const service = new ProjectScopeService(sql)
    const scope = await service.resolve({ roots: ['a'] })

    const result = scope.filterResources([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(result).toHaveLength(2)
    expect(result.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('filterProcesses includes by project_id', async () => {
    const sql = makeMockSql(['proj-1'])
    const service = new ProjectScopeService(sql)
    const scope = await service.resolve({ roots: ['proj-1'] })

    const processes = [
      { project_id: 'proj-1', name: 'A' },
      { project_id: 'proj-2', name: 'B' },
      { project_id: null, name: 'C' },
    ]

    const result = scope.filterProcesses(processes)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('A')
  })

  it('has() returns false for out-of-scope IDs', async () => {
    const sql = makeMockSql(['in-scope'])
    const service = new ProjectScopeService(sql)
    const scope = await service.resolve({ roots: ['in-scope'] })

    expect(scope.has('in-scope')).toBe(true)
    expect(scope.has('out-of-scope')).toBe(false)
  })

  it('empty roots with enforcement returns empty scope', async () => {
    const sql = makeMockSql([])
    const service = new ProjectScopeService(sql)
    const scope = await service.resolve({ roots: [] })
    expect(scope.resourceIds.size).toBe(0)
    expect(scope.filterResources([{ id: 'x' }])).toHaveLength(0)
  })
})
