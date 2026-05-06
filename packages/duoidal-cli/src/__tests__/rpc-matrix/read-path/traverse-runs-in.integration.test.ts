/**
 * Read-path: traverse runs links inward (find what runs a given skill).
 *
 * Strategy: create a cron that runs a skill, then query resource_links
 * to find what links TO the skill (in-direction traversal).
 */
import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from '../_harness.js'

const SUPABASE_URL = 'http://127.0.0.1:54321'
const SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

async function getInboundLinks(toId: string): Promise<Array<Record<string, unknown>>> {
  const url = `${SUPABASE_URL}/rest/v1/resource_links?to_id=eq.${toId}`
  const resp = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!resp.ok) throw new Error(`resource_links query failed: ${resp.status}`)
  return (await resp.json()) as Array<Record<string, unknown>>
}

describe('read-path: traverse runs (in direction)', () => {
  it('finds the cron that runs a skill via inbound resource_links', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const skillResult = await callRpcService('create_skill', {
        p_name: `skill-${suffix}`,
        p_config: { content: '# Test' },
        p_project_id: projectId,
      })
      assert(skillResult.ok, `create_skill failed`)
      const skillId = (Array.isArray(skillResult.data) ? skillResult.data[0] : skillResult.data as Record<string, unknown>)?.['skill_resource_id'] as string | undefined
      assert(typeof skillId === 'string', `Expected skill ID`)

      const cronResult = await callRpcService('create_cron', {
        p_name: `cron-${suffix}`,
        p_prompt: 'test prompt',
        p_enabled: true,
        p_schedule: '0 * * * *',
        p_project_id: projectId,
        p_skill_resource_id: skillId,
      })
      assert(cronResult.ok, `create_cron failed: ${JSON.stringify(cronResult.data)}`)
      const cronId = (Array.isArray(cronResult.data) ? cronResult.data[0] : cronResult.data as Record<string, unknown>)?.['cron_resource_id'] as string | undefined
      assert(typeof cronId === 'string', `Expected cron ID`)

      // Inward traversal from skill: find what runs the skill
      const inboundLinks = await getInboundLinks(skillId!)
      const runsLink = inboundLinks.find((l) => l['from_id'] === cronId)
      assert(runsLink !== undefined, `Expected cron→skill runs link in inbound resource_links, got: ${JSON.stringify(inboundLinks)}`)

      // Cleanup
      if (cronId) await callRpcService('delete_resource', { p_resource_id: cronId })
      if (skillId) await callRpcService('delete_resource', { p_resource_id: skillId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
