import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import postgres from 'postgres'
import { ProcessesService } from '../processes.js'

const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

describe.skipIf(!RUN_INTEGRATION)('ProcessesService.restart() — real Postgres (integration)', () => {
  // prepare: false required for Supabase transaction pooler (port 6543)
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: 'require' })
  const service = new ProcessesService(sql)

  // Real resource IDs to use as project_id (processes.project_id FK → resources.id)
  let projectA: string
  let projectB: string

  beforeAll(async () => {
    const resources = await sql`SELECT id FROM resources LIMIT 2`
    if (resources.length < 2) {
      throw new Error('Need at least 2 rows in resources table for integration test project_id values')
    }
    projectA = resources[0].id as string
    projectB = resources[1].id as string
  })

  afterEach(async () => {
    // Delete dependent rows first (epoch_results, agent_events reference processes)
    // then delete the test processes themselves
    await sql`
      DELETE FROM agent_events
      WHERE process_id IN (SELECT id FROM processes WHERE name LIKE 'test-restart-%')
    `
    await sql`
      DELETE FROM epoch_results
      WHERE campaign_id IN (SELECT id FROM processes WHERE name LIKE 'test-restart-%')
    `
    await sql`DELETE FROM processes WHERE name LIKE 'test-restart-%'`
  })

  it('(a) child inherits non-null project_id from parent', async () => {
    const parentId = await service.init({ name: `test-restart-a-${Date.now()}`, projectId: projectA })

    // Fail the parent so it's restartable
    await sql`UPDATE processes SET status = 'failed' WHERE id = ${parentId}`

    const { newId } = await service.restart(parentId)

    const child = await service.getById(newId)
    expect(child).not.toBeNull()
    expect(child!.project_id).toBe(projectA)
  })

  it('(b) child gets null project_id when parent project_id is null', async () => {
    const parentId = await service.init({ name: `test-restart-b-${Date.now()}` })

    await sql`UPDATE processes SET status = 'failed' WHERE id = ${parentId}`

    const { newId } = await service.restart(parentId)

    const child = await service.getById(newId)
    expect(child).not.toBeNull()
    expect(child!.project_id).toBeNull()
  })

  it('(c) blocked parent restart copies project_id and worktree_path', async () => {
    const parentId = await service.init({ name: `test-restart-c-${Date.now()}`, projectId: projectA })

    // Activate then block to get a blocked process with worktree_path
    await sql`UPDATE processes SET status = 'active' WHERE id = ${parentId}`
    await service.block(parentId, 'test blocker', '/some/worktree/path')

    const { newId } = await service.restart(parentId)

    const child = await service.getById(newId)
    expect(child).not.toBeNull()
    expect(child!.project_id).toBe(projectA)
    expect(child!.worktree_path).toBe('/some/worktree/path')
  })

  it('(d) no cross-project leakage — restart copies strictly from parent_process_id', async () => {
    // Create two parents in different projects
    const parentAId = await service.init({ name: `test-restart-d-a-${Date.now()}`, projectId: projectA })
    const parentBId = await service.init({ name: `test-restart-d-b-${Date.now()}`, projectId: projectB })

    await sql`UPDATE processes SET status = 'failed' WHERE name LIKE 'test-restart-d-%'`

    const { newId: childAId } = await service.restart(parentAId)

    const childA = await service.getById(childAId)
    expect(childA!.project_id).toBe(projectA)
    expect(childA!.project_id).not.toBe(projectB)
  })
})
