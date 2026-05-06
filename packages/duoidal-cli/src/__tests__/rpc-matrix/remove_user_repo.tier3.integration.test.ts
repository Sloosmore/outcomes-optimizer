import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier3: remove_user_repo', () => {
  it('executes RPC and returns success', async () => {
    await withTestUser(async ({ jwt, assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const owner = 'test-owner'
      const name = `test-repo-${suffix}`

      // Add a repo first
      await callRpc('add_user_repo', { p_owner: owner, p_repo_name: name }, jwt)

      // Remove the repo
      const result = await callRpc('remove_user_repo', { p_owner: owner, p_name: name }, jwt)
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')
    })
  })
})
