import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: delete_link', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ jwt, resourceId, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Create a project and add user as member (creates a link)
      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      // Add user as project member
      await callRpcService('add_project_member', { p_from_id: resourceId, p_to_id: projectId! })

      // Delete the link
      const result = await callRpc('delete_link', {
        p_from_id: resourceId,
        p_to_id: projectId!,
        p_link_type: 'member_of',
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
