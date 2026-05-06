import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: create_access_code', () => {
  it('executes RPC and returns access code ID', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const result = await callRpc('create_access_code', { p_code: `test-code-${suffix}`, p_config: { role: 'tester' } }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const row = rows[0] as Record<string, unknown> | undefined
      assert(row?.['access_code_id'] !== undefined || row?.['code'] !== undefined, `Expected access code data, got: ${JSON.stringify(result.data)}`)
    })
  })
})
