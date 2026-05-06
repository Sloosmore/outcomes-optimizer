import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: create_user', () => {
  it('creates a user resource and returns user resource ID', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const result = await callRpcService('create_user', {
        p_name: `user-${suffix}`,
        p_config: { display_name: `Test User ${suffix}` },
        p_project_id: projectId,
      })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const userId = (rows[0] as Record<string, unknown>)?.['user_resource_id'] as string | undefined
      assert(typeof userId === 'string' && userId.length > 0, `Expected user_resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      if (userId) await callRpcService('delete_resource', { p_resource_id: userId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
