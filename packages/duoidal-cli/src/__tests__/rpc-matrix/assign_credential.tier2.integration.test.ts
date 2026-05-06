import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: assign_credential', () => {
  it('links a server to a credential via resource link and returns success', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const serverResult = await callRpcService('create_server', { p_name: `server-${suffix}`, p_config: { ip: '1.2.3.4' }, p_project_id: projectId })
      assert(serverResult.ok, `create_server failed`)
      const serverId = (Array.isArray(serverResult.data) ? serverResult.data[0] : serverResult.data as Record<string, unknown>)?.['server_resource_id'] as string | undefined
      assert(typeof serverId === 'string', `Expected server ID`)

      const credResult = await callRpcService('create_credential', { p_name: `cred-${suffix}`, p_config: {}, p_project_id: projectId, p_doppler_project: `doppler-${suffix}` })
      assert(credResult.ok, `create_credential failed`)
      const credId = (Array.isArray(credResult.data) ? credResult.data[0] : credResult.data as Record<string, unknown>)?.['credential_resource_id'] as string | undefined
      assert(typeof credId === 'string', `Expected credential ID`)

      const result = await callRpcService('assign_credential', { p_from_id: serverId, p_to_id: credId })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (credId) await callRpcService('delete_resource', { p_resource_id: credId })
      if (serverId) await callRpcService('delete_resource', { p_resource_id: serverId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
