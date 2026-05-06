import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier1: provision_sandbox', () => {
  it('provisions a sandbox via RPC and returns server resource ID', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const result = await callRpc('provision_sandbox', {
        p_server_name: `test-server-${suffix}`,
        p_ssh_key_name: `test-key-${suffix}`,
        p_public_key: 'ssh-ed25519 AAAA test-fake-key',
        p_hetzner_server_id: null,
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const serverResourceId = (rows[0] as Record<string, unknown>)?.['server_resource_id'] as string | undefined
      assert(typeof serverResourceId === 'string' && serverResourceId.length > 0, `Expected server_resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup via deprovision
      if (serverResourceId) {
        await callRpc('deprovision_sandbox', { p_server_resource_id: serverResourceId }, jwt)
      }
    })
  })
})
