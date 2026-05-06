import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: upload_skill', () => {
  it('uploads a skill via skills upload path and returns resource ID', async () => {
    await withTestUser(async ({ resourceId, assert }) => {
      const result = await callRpcService('upload_skill', {
        p_actor_id: resourceId,
        p_content: '# Uploaded Skill\n\nThis is test skill content for the tier2 upload test path.',
      })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const skillId = (rows[0] as Record<string, unknown>)?.['resource_id'] as string | undefined
      assert(typeof skillId === 'string' && skillId.length > 0, `Expected resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      if (skillId) await callRpcService('delete_resource', { p_resource_id: skillId })
    })
  })
})
