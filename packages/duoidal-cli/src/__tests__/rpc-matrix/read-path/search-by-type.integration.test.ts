/**
 * Read-path: search resources filtered by type.
 *
 * Uses Supabase REST API with both ilike name filter and type equality filter.
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

async function searchResourcesByType(query: string, type: string): Promise<Array<Record<string, unknown>>> {
  const url = `${SUPABASE_URL}/rest/v1/resources?name=ilike.*${encodeURIComponent(query)}*&type=eq.${encodeURIComponent(type)}`
  const resp = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!resp.ok) throw new Error(`resources search failed: ${resp.status}`)
  return (await resp.json()) as Array<Record<string, unknown>>
}

describe('read-path: search by type', () => {
  it('finds resources filtered by type using name and type query', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const projectName = `proj-${suffix}`

      const projResult = await callRpcService('create_project', { p_name: projectName })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      // Create a skill with same suffix — it should NOT appear in project-typed search
      const skillResult = await callRpcService('create_skill', {
        p_name: `skill-${suffix}`,
        p_config: { content: '# Test' },
        p_project_id: projectId,
      })
      assert(skillResult.ok, `create_skill failed`)
      const skillId = (Array.isArray(skillResult.data) ? skillResult.data[0] : skillResult.data as Record<string, unknown>)?.['skill_resource_id'] as string | undefined
      assert(typeof skillId === 'string', `Expected skill ID`)

      // Search for projects matching suffix
      const results = await searchResourcesByType(suffix, 'project')
      assert(results.length > 0, `Expected at least one result for type=project matching "${suffix}"`)
      const found = results.find((r) => r['name'] === projectName)
      assert(found !== undefined, `Expected to find ${projectName} in type-filtered results, got: ${JSON.stringify(results.map((r) => r['name']))}`)

      // All returned results must be type=project (no skills or other types)
      const wrongType = results.filter((r) => r['type'] !== 'project')
      assert(wrongType.length === 0, `Expected all results to be type=project, got: ${JSON.stringify(wrongType)}`)

      // Cleanup
      if (skillId) await callRpcService('delete_resource', { p_resource_id: skillId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
