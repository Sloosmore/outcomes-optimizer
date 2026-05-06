import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: remove_github_installation', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      // Store a GitHub installation first
      const storeResult = await callRpc('store_github_installation', {
        p_installation_id: String(Math.floor(Math.random() * 900000) + 100000),
        p_token: 'ghs_fake_token_for_test',
        p_provider: 'github',
        p_sandbox_name: `sandbox-${suffix}`,
      }, jwt)
      assert(storeResult.ok, `store_github_installation failed: ${JSON.stringify(storeResult.data)}`)

      // Remove the installation
      const result = await callRpc('remove_github_installation', {}, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
