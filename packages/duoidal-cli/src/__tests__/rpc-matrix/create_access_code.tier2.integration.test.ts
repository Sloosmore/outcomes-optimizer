import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: create_access_code', () => {
  it('creates an access code via admin path and returns access code resource ID', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const result = await callRpcService('create_access_code', {
        p_code: `test-code-${suffix}`,
        p_config: { max_uses: 1 },
      })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const codeId = ((rows[0] as Record<string, unknown>)?.['access_code_resource_id'] ??
        (rows[0] as Record<string, unknown>)?.['access_code_id']) as string | undefined
      assert(typeof codeId === 'string' && codeId.length > 0, `Expected access_code_resource_id or access_code_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      if (codeId) await callRpcService('delete_resource', { p_resource_id: codeId })
    })
  })
})
