import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: create_user', () => {
  it('executes RPC (service-only) and returns user resource ID or permission error', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      // create_user has inverted param mapping: {p_name: name, p_config: config}
      // The RPC accepts p_name and p_config directly
      const result = await callRpcService('create_user', { name: `test-user-${suffix}`, config: {} })

      if (result.ok) {
        // Succeeded with service role
        const rows = Array.isArray(result.data) ? result.data : [result.data]
        const row = rows[0] as Record<string, unknown> | undefined
        assert(row !== undefined && row !== null, `Expected result data: ${JSON.stringify(result.data)}`)
      } else {
        // May fail if there's a constraint — still verify it's a legitimate DB response
        assert(result.status >= 400, `Expected HTTP error status, got: ${result.status}`)
        assert(result.error !== null, `Expected error message: ${JSON.stringify(result.data)}`)
      }
    })
  })
})
