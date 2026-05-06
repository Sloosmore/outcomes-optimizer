/**
 * Read-path: search across all resource types.
 *
 * Uses the Supabase REST API with ilike filter to search resources by
 * name substring across all types.
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

async function searchResources(query: string): Promise<Array<Record<string, unknown>>> {
  const url = `${SUPABASE_URL}/rest/v1/resources?name=ilike.*${encodeURIComponent(query)}*`
  const resp = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!resp.ok) throw new Error(`resources search failed: ${resp.status}`)
  return (await resp.json()) as Array<Record<string, unknown>>
}

describe('read-path: search all types', () => {
  it('finds resources by name substring across all types', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const projectName = `proj-${suffix}`

      const projResult = await callRpcService('create_project', { p_name: projectName })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      // Search using the unique suffix
      const results = await searchResources(suffix)
      assert(results.length > 0, `Expected at least one search result for "${suffix}", got empty array`)
      const found = results.find((r) => r['name'] === projectName || r['id'] === projectId)
      assert(found !== undefined, `Expected to find ${projectName} in search results, got: ${JSON.stringify(results.map((r) => r['name']))}`)

      // Cleanup
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
