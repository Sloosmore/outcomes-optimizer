import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: provision_user', () => {
  it('provisions a user via service-role RPC and returns user resource ID', async () => {
    await withTestUser(async ({ authUid, resourceId, assert }) => {
      // The harness creates a resource row. Delete it first so provision_user can create its own.
      await callRpcService('delete_resource', { p_resource_id: resourceId })

      const result = await callRpcService('provision_user', {
        p_auth_user_id: authUid,
        p_email: `test-${authUid.slice(0, 8)}@rpc-matrix.test`,
      })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const userResourceId = (rows[0] as Record<string, unknown>)?.['user_resource_id'] as string | undefined
      assert(typeof userResourceId === 'string' && userResourceId.length > 0, `Expected user_resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      if (userResourceId) {
        const projectResult = (rows[0] as Record<string, unknown>)?.['project_resource_id'] as string | undefined
        if (projectResult) await callRpcService('delete_resource', { p_resource_id: projectResult })
        await callRpcService('delete_resource', { p_resource_id: userResourceId })
      }
    })
  })
})
