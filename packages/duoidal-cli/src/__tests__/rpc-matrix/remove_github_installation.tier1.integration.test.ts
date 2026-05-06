import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier1: remove_github_installation', () => {
  it('removes the GitHub installation via RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const result = await callRpc('remove_github_installation', {}, jwt)
      // This is idempotent — may succeed with null data if no installation exists
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
    })
  })
})
