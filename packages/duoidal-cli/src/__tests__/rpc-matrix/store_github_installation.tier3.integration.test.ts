import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: store_github_installation', () => {
  it('executes RPC and returns credential resource ID (DB row only)', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const installationId = String(Math.floor(Math.random() * 900000) + 100000)

      const result = await callRpc('store_github_installation', {
        p_installation_id: installationId,
        p_token: 'ghs_fake_token_for_test',
        p_provider: 'github',
        p_sandbox_name: `sandbox-${suffix}`,
      }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const credResourceId = (rows[0] as Record<string, unknown>)?.['credential_resource_id'] as string | undefined
      assert(typeof credResourceId === 'string' && credResourceId.length > 0, `Expected credential_resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      await callRpc('remove_github_installation', {}, jwt)
    })
  })
})
