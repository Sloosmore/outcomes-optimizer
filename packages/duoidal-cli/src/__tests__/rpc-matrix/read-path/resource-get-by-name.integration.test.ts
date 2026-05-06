/**
 * Read-path: fetch a resource by name.
 *
 * Queries the resources table via Supabase REST API by exact name match.
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

async function getResourceByName(name: string): Promise<Record<string, unknown> | null> {
  const url = `${SUPABASE_URL}/rest/v1/resources?name=eq.${encodeURIComponent(name)}&limit=1`
  const resp = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!resp.ok) throw new Error(`resources query failed: ${resp.status}`)
  const rows = (await resp.json()) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

describe('read-path: resource get by name', () => {
  it('fetches a resource by its exact name and returns correct fields', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const projectName = `proj-${suffix}`

      const projResult = await callRpcService('create_project', { p_name: projectName })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const resource = await getResourceByName(projectName)
      assert(resource !== null, `Expected to find resource with name=${projectName}`)
      assert(resource!['name'] === projectName, `Expected name=${projectName}, got: ${resource!['name']}`)
      assert(resource!['id'] === projectId, `Expected id=${projectId}, got: ${resource!['id']}`)
      assert(resource!['type'] === 'project', `Expected type=project, got: ${resource!['type']}`)

      // Cleanup
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
