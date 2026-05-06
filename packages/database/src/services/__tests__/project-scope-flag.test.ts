import { describe, it, expect, vi } from 'vitest'

vi.mock('../../constants.js', () => ({ ENFORCE_PROJECT_SCOPING: true }))

import { ProjectScopeService } from '../project-scope.js'

function makeMockSql(returnedIds: string[]) {
  const rows = returnedIds.map(id => ({ resource_id: id }))
  const sql = vi.fn(() => Promise.resolve(rows)) as any
  sql.end = vi.fn()
  return sql
}

describe('ENFORCE_PROJECT_SCOPING=true enforcement', () => {
  it('flag=true: empty roots returns empty scope immediately (no DB call)', async () => {
    const sql = makeMockSql([])
    const service = new ProjectScopeService(sql)
    const scope = await service.resolve({ roots: [] })
    // sql should NOT be called since early return kicks in
    expect(sql).not.toHaveBeenCalled()
    expect(scope.resourceIds.size).toBe(0)
    expect(scope.filterResources([{ id: 'x' }])).toHaveLength(0)
  })

  it('flag=true with roots provided: RPC call proceeds normally', async () => {
    const sql = makeMockSql(['root', 'child'])
    const service = new ProjectScopeService(sql)
    const scope = await service.resolve({ roots: ['root'] })
    expect(scope.resourceIds.has('root')).toBe(true)
    expect(scope.resourceIds.has('child')).toBe(true)
  })
})
