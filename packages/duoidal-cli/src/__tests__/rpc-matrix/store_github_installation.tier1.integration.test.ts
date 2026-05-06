import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier1: store_github_installation', () => {
  it('stores a GitHub installation via RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const result = await callRpc('store_github_installation', {
        p_installation_id: `test-install-${suffix}`,
        p_token: `test-token-${suffix}`,
        p_sandbox_name: `test-sandbox-${suffix}`,
        p_provider: 'github',
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
