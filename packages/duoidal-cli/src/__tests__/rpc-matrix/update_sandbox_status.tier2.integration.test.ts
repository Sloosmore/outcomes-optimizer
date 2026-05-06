import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: update_sandbox_status', () => {
  it('updates sandbox status via generic update path and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Provision a sandbox first
      const provResult = await callRpc('provision_sandbox', {
        p_server_name: `test-server-${suffix}`,
        p_ssh_key_name: `test-key-${suffix}`,
        p_public_key: 'ssh-ed25519 AAAA test-fake-key',
        p_hetzner_server_id: null,
      }, jwt)
      assert(provResult.ok, `provision_sandbox failed: ${JSON.stringify(provResult.data)}`)
      const provRows = Array.isArray(provResult.data) ? provResult.data : [provResult.data]
      const serverResourceId = (provRows[0] as Record<string, unknown>)?.['server_resource_id'] as string | undefined
      assert(typeof serverResourceId === 'string', `Expected server_resource_id`)

      // Update sandbox status
      const result = await callRpc('update_sandbox_status', {
        p_server_resource_id: serverResourceId!,
        p_status: 'active',
        p_ip: '1.2.3.4',
        p_hetzner_server_id: 12345,
        p_provisioned_at: new Date().toISOString(),
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (serverResourceId) await callRpcService('deprovision_sandbox', { p_server_resource_id: serverResourceId })
    })
  })
})
