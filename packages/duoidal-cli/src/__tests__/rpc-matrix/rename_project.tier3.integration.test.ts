import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: rename_project', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Create project
      const projResult = await callRpcService('create_project', { p_name: `proj-original-${suffix}` })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectResourceId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectResourceId === 'string', `Expected project ID`)

      // Rename project
      const result = await callRpc('rename_project', {
        p_project_resource_id: projectResourceId!,
        p_new_name: `proj-renamed-${suffix}`,
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (projectResourceId) await callRpcService('delete_resource', { p_resource_id: projectResourceId })
    })
  })
})
