import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from './_harness.js'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

describe('tier2: create_cron', () => {
  it('creates a cron resource and returns cron resource ID', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const skillResult = await callRpcService('create_skill', { p_name: `skill-${suffix}`, p_config: { content: '# Test' }, p_project_id: projectId })
      assert(skillResult.ok, `create_skill failed: ${JSON.stringify(skillResult.data)}`)
      const skillId = (Array.isArray(skillResult.data) ? skillResult.data[0] : skillResult.data as Record<string, unknown>)?.['skill_resource_id'] as string | undefined
      assert(typeof skillId === 'string', `Expected skill ID`)

      const result = await callRpcService('create_cron', {
        p_name: `cron-${suffix}`,
        p_prompt: 'test prompt',
        p_enabled: true,
        p_schedule: '0 * * * *',
        p_project_id: projectId,
        p_skill_resource_id: skillId,
      })
      assert(result.ok, `RPC should succeed, got status ${result.status}: ${JSON.stringify(result.data)}`)

      const rows = Array.isArray(result.data) ? result.data : [result.data]
      const cronId = (rows[0] as Record<string, unknown>)?.['cron_resource_id'] as string | undefined
      assert(typeof cronId === 'string' && cronId.length > 0, `Expected cron_resource_id, got: ${JSON.stringify(result.data)}`)

      // Cleanup
      if (cronId) await callRpcService('delete_resource', { p_resource_id: cronId })
      if (skillId) await callRpcService('delete_resource', { p_resource_id: skillId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
