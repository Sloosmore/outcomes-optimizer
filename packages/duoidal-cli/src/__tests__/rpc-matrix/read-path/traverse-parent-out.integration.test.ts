/**
 * Read-path: traverse parent links outward.
 *
 * Strategy: create a project and a skill linked as a child of the project
 * (parent link from skill → project), then query resource_links to verify
 * the out-direction traversal result.
 *
 * Uses direct Supabase REST API against the resource_links table rather
 * than the CLI, because the CLI requires a fully provisioned BFF user
 * which the test harness does not set up.
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

async function getResourceLinks(fromId: string): Promise<Array<Record<string, unknown>>> {
  const url = `${SUPABASE_URL}/rest/v1/resource_links?from_id=eq.${fromId}`
  const resp = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!resp.ok) throw new Error(`resource_links query failed: ${resp.status}`)
  return (await resp.json()) as Array<Record<string, unknown>>
}

describe('read-path: traverse parent (out direction)', () => {
  it('parent link from skill to project appears in resource_links', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)

      const projResult = await callRpcService('create_project', { p_name: `proj-${suffix}` })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
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

      // assign_parent creates a parent link: skill → project
      const linkResult = await callRpcService('assign_parent', { p_from_id: skillId, p_to_id: projectId })
      assert(linkResult.ok, `assign_parent failed: ${JSON.stringify(linkResult.data)}`)

      // Verify the link appears in the out-direction traversal (resource_links from skill)
      const links = await getResourceLinks(skillId!)
      const parentLink = links.find((l) => l['to_id'] === projectId && l['link_type'] === 'parent')
      assert(parentLink !== undefined, `Expected parent link from skill to project in resource_links, got: ${JSON.stringify(links)}`)

      // Cleanup
      if (skillId) await callRpcService('delete_resource', { p_resource_id: skillId })
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
