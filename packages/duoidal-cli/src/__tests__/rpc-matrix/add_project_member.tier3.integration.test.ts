import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: add_project_member', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ resourceId, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Create project
      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projRows = Array.isArray(projResult.data) ? projResult.data : [projResult.data]
      const projectId = (projRows[0] as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID: ${JSON.stringify(projResult.data)}`)

      // Add user as project member
      const result = await callRpcService('add_project_member', { p_from_id: resourceId, p_to_id: projectId! })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
