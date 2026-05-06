import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: create_proxy', () => {
  it('executes RPC and returns proxy resource ID', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const result = await callRpcService('create_proxy', { p_name: `proxy-${suffix}`, p_config: { url: 'https://proxy.test.example' }, p_project_id: projectId })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const proxyId = (rows[0] as Record<string, unknown>)?.['proxy_resource_id'] as string | undefined
      assert(typeof proxyId === 'string' && proxyId.length > 0, `Expected proxy_resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      if (proxyId) await callRpcService('delete_resource', { p_resource_id: proxyId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
