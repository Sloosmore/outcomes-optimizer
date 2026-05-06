import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier1: store_user_credential', () => {
  it('stores a user credential via RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const result = await callRpc('store_user_credential', {
        p_sandbox_name: `test-sandbox-${suffix}`,
        p_provider: `test-provider-${suffix}`,
        p_credential_value: `test-credential-value-${suffix}`,
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
