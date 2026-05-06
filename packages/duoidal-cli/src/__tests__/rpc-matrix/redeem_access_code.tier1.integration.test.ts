import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier1: redeem_access_code', () => {
  it('redeems an access code via RPC and returns success', async () => {
    await withTestUser(async ({ resourceId, jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Create an access code first
      const codeResult = await callRpcService('create_access_code', {
        p_code: `test-code-${suffix}`,
        p_config: { max_uses: 1 },
      })
      assert(codeResult.ok, `create_access_code failed: ${JSON.stringify(codeResult.data)}`)
      const codeRows = Array.isArray(codeResult.data) ? codeResult.data : [codeResult.data]
      const codeResourceId = ((codeRows[0] as Record<string, unknown>)?.['access_code_resource_id'] ??
        (codeRows[0] as Record<string, unknown>)?.['access_code_id']) as string | undefined
      assert(typeof codeResourceId === 'string', `Expected access_code_resource_id or access_code_id: ${JSON.stringify(codeResult.data)}`)

      // Redeem the access code
      const result = await callRpc('redeem_access_code', {
        p_code: `test-code-${suffix}`,
        p_user_id: resourceId,
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (codeResourceId) await callRpcService('delete_resource', { p_resource_id: codeResourceId })
    })
  })
})
