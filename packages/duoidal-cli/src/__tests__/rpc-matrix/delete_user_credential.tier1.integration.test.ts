import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier1: delete_user_credential', () => {
  it('deletes a user credential via RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Store a credential first so we have one to delete
      const storeResult = await callRpc('store_user_credential', {
        p_sandbox_name: `test-sandbox-${suffix}`,
        p_provider: `test-provider-${suffix}`,
        p_credential_value: `test-credential-value-${suffix}`,
      }, jwt)
      assert(storeResult.ok, `store_user_credential failed: ${JSON.stringify(storeResult.data)}`)

      const storeRows = Array.isArray(storeResult.data) ? storeResult.data : [storeResult.data]
      const credentialResourceId = (storeRows[0] as Record<string, unknown>)?.['credential_resource_id'] as string | undefined
      assert(typeof credentialResourceId === 'string', `Expected credential_resource_id: ${JSON.stringify(storeResult.data)}`)

      // Now delete it
      const result = await callRpc('delete_user_credential', {
        p_credential_resource_id: credentialResourceId!,
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
