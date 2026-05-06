import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: create_project', () => {
  it('executes RPC and returns project resource ID', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const result = await callRpcService('create_project', { p_name: `test-proj-${suffix}` })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      // RPC returns array of rows
      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const row = rows[0] as Record<string, unknown> | undefined
      const projectId = row?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string' && projectId.length > 0, `Expected project_resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
