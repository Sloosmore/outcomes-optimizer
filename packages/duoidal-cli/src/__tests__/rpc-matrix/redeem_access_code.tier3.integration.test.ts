import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: redeem_access_code', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ jwt, resourceId, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const code = `test-redeem-${suffix}`

      // Create an access code
      const createResult = await callRpc('create_access_code', { p_code: code, p_config: { role: 'tester' } }, jwt)
      assert(createResult.ok, `create_access_code failed: ${JSON.stringify(createResult.data)}`)

      // Redeem the access code
      const result = await callRpc('redeem_access_code', { p_code: code, p_user_id: resourceId }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const redeemed = (rows[0] as Record<string, unknown>)?.['redeemed'] as boolean | undefined
      assert(redeemed === true, `Expected redeemed=true, got: ${JSON.stringify(result.data)}`)
    })
  })
})
