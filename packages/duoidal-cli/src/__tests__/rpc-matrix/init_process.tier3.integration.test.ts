import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: init_process', () => {
  it('executes RPC and returns process ID', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // init_process is service-role only
      const result = await callRpcService('init_process', {
        p_name: `test-process-${suffix}`,
        p_branch: `test/branch-${suffix}`,
        p_run_type: 'local',
      })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const processId = (rows[0] as Record<string, unknown>)?.['process_id'] as string | undefined
      assert(typeof processId === 'string' && processId.length > 0, `Expected process_id, got: ${JSON.stringify(result.data)}`)
    })
  })
})
