import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: update_resource_status', () => {
  it('executes RPC and returns resource ID', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const serverResult = await callRpcService('create_server', { p_name: `server-${suffix}`, p_config: {}, p_project_id: projectId })
      assert(serverResult.ok, `create_server failed`)
      const resourceId = (Array.isArray(serverResult.data) ? serverResult.data[0] : serverResult.data as Record<string, unknown>)?.['server_resource_id'] as string | undefined
      assert(typeof resourceId === 'string', `Expected server ID`)

      const result = await callRpc('update_resource_status', {
        p_resource_id: resourceId!,
        p_new_status: 'active',
        p_expected_status: null,
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (resourceId) await callRpcService('delete_resource', { p_resource_id: resourceId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
