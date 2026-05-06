import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: fail_process', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Create a process first (service-role only)
      const initResult = await callRpcService('init_process', {
        p_name: `test-proc-${suffix}`,
        p_branch: `test/branch-${suffix}`,
        p_run_type: 'local',
      })
      assert(initResult.ok, `init_process failed: ${JSON.stringify(initResult.data)}`)

      const initRows = Array.isArray(initResult.data) ? initResult.data : [initResult.data]
      const processId = (initRows[0] as Record<string, unknown>)?.['process_id'] as string | undefined
      assert(typeof processId === 'string', `Expected process_id: ${JSON.stringify(initResult.data)}`)

      // Fail the process (service-role only)
      const result = await callRpcService('fail_process', {
        p_process_id: processId!,
        p_reason: 'test failure from tier3',
      })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
