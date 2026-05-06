/**
 * Read-path: list resources.
 *
 * Queries the resources table via Supabase REST API, optionally filtered by type.
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

async function listResources(type?: string): Promise<Array<Record<string, unknown>>> {
  const filter = type ? `?type=eq.${encodeURIComponent(type)}` : ''
  const url = `${SUPABASE_URL}/rest/v1/resources${filter}`
  const resp = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!resp.ok) throw new Error(`resources list failed: ${resp.status}`)
  return (await resp.json()) as Array<Record<string, unknown>>
}

describe('read-path: resource list', () => {
  it('lists all resources and includes a newly created project', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const projectName = `proj-${suffix}`

      const projResult = await callRpcService('create_project', { p_name: projectName })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const resources = await listResources()
      assert(resources.length > 0, 'Expected at least one resource in list')
      const found = resources.find((r) => r['name'] === projectName || r['id'] === projectId)
      assert(found !== undefined, `Expected to find created project in resource list`)

      // Cleanup
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })

  it('lists resources filtered by type and includes the created resource', async () => {
    await withTestUser(async ({ assert }) => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const projectName = `proj-${suffix}`

      const projResult = await callRpcService('create_project', { p_name: projectName })
      assert(projResult.ok, `create_project failed: ${JSON.stringify(projResult.data)}`)
      const projectId = (Array.isArray(projResult.data) ? projResult.data[0] : projResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined
      assert(typeof projectId === 'string', `Expected project ID`)

      const resources = await listResources('project')
      assert(resources.length > 0, 'Expected at least one project resource')
      const found = resources.find((r) => r['name'] === projectName || r['id'] === projectId)
      assert(found !== undefined, `Expected to find created project in type-filtered list`)

      // All items must be of type project
      const wrongType = resources.filter((r) => r['type'] !== 'project')
      assert(wrongType.length === 0, `Expected all results to be type=project, got: ${JSON.stringify(wrongType)}`)

      // Cleanup
      if (projectId) await callRpcService('delete_resource', { p_resource_id: projectId })
    })
  })
})
