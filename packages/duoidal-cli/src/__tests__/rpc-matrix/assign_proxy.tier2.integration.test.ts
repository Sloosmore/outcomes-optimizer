import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: assign_proxy', () => {
  it('links an identity to a proxy via resource link and returns success', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const identityResult = await callRpcService('create_identity', { p_name: `identity-${suffix}`, p_handle: `handle-${suffix}`, p_config: {}, p_project_id: projectId })
      assert(identityResult.ok, `create_identity failed`)
      const identityId = (Array.isArray(identityResult.data) ? identityResult.data[0] : identityResult.data as Record<string, unknown>)?.['identity_resource_id'] as string | undefined
      assert(typeof identityId === 'string', `Expected identity ID`)

      const proxyResult = await callRpcService('create_proxy', { p_name: `proxy-${suffix}`, p_config: { url: 'https://proxy.test.example' }, p_project_id: projectId })
      assert(proxyResult.ok, `create_proxy failed`)
      const proxyId = (Array.isArray(proxyResult.data) ? proxyResult.data[0] : proxyResult.data as Record<string, unknown>)?.['proxy_resource_id'] as string | undefined
      assert(typeof proxyId === 'string', `Expected proxy ID`)

      const result = await callRpcService('assign_proxy', { p_from_id: identityId, p_to_id: proxyId })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (identityId) await callRpcService('delete_resource', { p_resource_id: identityId })
      if (proxyId) await callRpcService('delete_resource', { p_resource_id: proxyId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
