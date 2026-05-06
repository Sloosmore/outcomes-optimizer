import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: assign_parent', () => {
  it('links a skill to a project parent via resource link and returns success', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const skillResult = await callRpcService('create_skill', { p_name: `skill-${suffix}`, p_config: { content: '# Test' }, p_project_id: projectId })
      assert(skillResult.ok, `create_skill failed`)
      const skillId = (Array.isArray(skillResult.data) ? skillResult.data[0] : skillResult.data as Record<string, unknown>)?.['skill_resource_id'] as string | undefined
      assert(typeof skillId === 'string', `Expected skill ID`)

      const result = await callRpcService('assign_parent', { p_from_id: skillId, p_to_id: projectId })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)
      assert(result.data !== null, 'Should produce data')

      // Cleanup
      if (skillId) await callRpcService('delete_resource', { p_resource_id: skillId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
