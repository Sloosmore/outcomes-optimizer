import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: delete_user_credential', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Store a credential first
      const storeResult = await callRpc('store_user_credential', {
        p_provider: 'anthropic',
        p_sandbox_name: `sandbox-${suffix}`,
        p_credential_value: 'sk-test-fake-credential',
      }, jwt)
      assert(storeResult.ok, `store_user_credential failed: ${JSON.stringify(storeResult.data)}`)

      const storeRows = Array.isArray(storeResult.data) ? storeResult.data : [storeResult.data]
      const credResourceId = (storeRows[0] as Record<string, unknown>)?.['credential_resource_id'] as string | undefined
      assert(typeof credResourceId === 'string', `Expected credential_resource_id: ${JSON.stringify(storeResult.data)}`)

      // Delete the credential
      const result = await callRpc('delete_user_credential', { p_credential_resource_id: credResourceId! }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
