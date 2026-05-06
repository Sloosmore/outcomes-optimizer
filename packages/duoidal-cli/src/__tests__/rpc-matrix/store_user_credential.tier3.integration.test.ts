import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: store_user_credential', () => {
  it('executes RPC and returns credential resource ID', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const result = await callRpc('store_user_credential', {
        p_provider: 'anthropic',
        p_sandbox_name: `sandbox-${suffix}`,
        p_credential_value: 'sk-test-fake-credential',
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const credResourceId = (rows[0] as Record<string, unknown>)?.['credential_resource_id'] as string | undefined
      assert(typeof credResourceId === 'string' && credResourceId.length > 0, `Expected credential_resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      if (credResourceId) await callRpc('delete_user_credential', { p_credential_resource_id: credResourceId }, jwt)
    })
  })
})
