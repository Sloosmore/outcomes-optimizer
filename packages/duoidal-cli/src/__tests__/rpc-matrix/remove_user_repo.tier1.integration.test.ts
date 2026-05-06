import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier1: remove_user_repo', () => {
  it('removes a repo via remove_user_repo RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const repoOwner = 'test-owner'
      const repoName = `test-repo-${suffix}`

      // First add the repo
      const addResult = await callRpc('add_user_repo', { p_owner: repoOwner, p_repo_name: repoName }, jwt)
      assert(addResult.ok, `add_user_repo failed: ${JSON.stringify(addResult.data)}`)

      // Then remove it
      const result = await callRpc('remove_user_repo', { p_owner: repoOwner, p_name: repoName }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
