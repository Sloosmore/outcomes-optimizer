import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: deprovision_sandbox', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Provision a sandbox first
      const provisionResult = await callRpc('provision_sandbox', {
        p_server_name: `test-server-${suffix}`,
        p_ssh_key_name: `test-key-${suffix}`,
        p_public_key: 'ssh-ed25519 AAAA test-fake-key',
        p_hetzner_server_id: null,
      }, jwt)
      assert(provisionResult.ok, `provision_sandbox failed: ${JSON.stringify(provisionResult.data)}`)

      const provRows = Array.isArray(provisionResult.data) ? provisionResult.data : [provisionResult.data]
      const serverResourceId = (provRows[0] as Record<string, unknown>)?.['server_resource_id'] as string | undefined
      assert(typeof serverResourceId === 'string', `Expected server_resource_id: ${JSON.stringify(provisionResult.data)}`)

      // Deprovision via service role (service_role only)
      const result = await callRpcService('deprovision_sandbox', { p_server_resource_id: serverResourceId! })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
