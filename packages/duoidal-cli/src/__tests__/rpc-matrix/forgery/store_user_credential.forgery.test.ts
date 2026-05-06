/**
 * Forgery test: store_user_credential
 *
 * Verifies that when Alice sends her JWT + Bob's resource_id as p_user_resource_id,
 * the RPC ignores p_user_resource_id and derives identity from Alice's JWT (auth.uid()).
 *
 * PRE-MIGRATION (RED state):
 * - add_user_repo/remove_user_repo: function doesn't exist → 404 → result.ok = false → assertion fails → RED
 * - Other RPCs: ownership check rejects Alice's attempt to use Bob's resource_id → 403 → result.ok = false → RED
 *
 * POST-MIGRATION (GREEN state):
 * - RPC ignores p_user_resource_id, uses app.current_user_resource_id() from JWT
 * - Call succeeds on Alice's data (not Bob's) → result.ok = true → GREEN
 */

import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpc } from '../_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error(
      'RUN_INTEGRATION must be set for the rpc-matrix suite. ' +
        'Run with: RUN_INTEGRATION=true pnpm test -- rpc-matrix'
    )
  }
})

describe('forgery: store_user_credential — Alice cannot act as Bob', () => {
  it('RPC ignores p_user_resource_id and uses JWT identity (RED: ownership check rejects Bob resource_id)', async () => {
    await withTestUser(async (alice) => {
      await withTestUser(async (bob) => {
        // Alice sends her JWT but Bob's resource_id — post-migration the RPC ignores it
        const result = await callRpc(
          'store_user_credential',
          {
            p_user_resource_id: bob.resourceId,
            p_sandbox_name: 'forgery-sandbox',
            p_provider: 'anthropic',
            p_credential_value: 'sk-fake-credential',
          },
          alice.jwt
        )

        // POST-MIGRATION (GREEN): RPC ignores p_user_resource_id, derives identity from JWT → succeeds
        // PRE-MIGRATION (RED): ownership check (WHERE id = bob_id AND name = 'user:' || alice.uid) fails → 403 → RED
        alice.assert(
          result.ok,
          `Expected RPC to succeed with JWT-derived identity (post-migration), got status ${result.status}: ${JSON.stringify(result.data)}`
        )
      })
    })
  })
})
