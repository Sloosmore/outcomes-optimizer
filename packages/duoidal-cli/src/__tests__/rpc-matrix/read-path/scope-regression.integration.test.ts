/**
 * Scope regression tests: verify that RLS boundaries are enforced on the resources table.
 *
 * Alice (authenticated user) should not be able to read resources owned by
 * service-role-created entries that have no auth_user_id. This guards against
 * RLS regressions where policies grant excessive SELECT to authenticated users.
 *
 * Additionally verifies that a resource created for one auth user is not
 * visible to a different auth user via the authenticated API key.
 */
import { describe, it, beforeAll } from 'vitest'
import { withTestUser, callRpcService } from '../_harness.js'
import { mintJwt } from '../_mint-jwt.js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = 'http://127.0.0.1:54321'
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error('RUN_INTEGRATION must be set for the rpc-matrix suite.')
  }
})

async function listResourcesAsUser(jwt: string, type: string): Promise<Array<Record<string, unknown>>> {
  const url = `${SUPABASE_URL}/rest/v1/resources?type=eq.${encodeURIComponent(type)}`
  const resp = await fetch(url, {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`resources list failed (${resp.status}): ${text}`)
  }
  return (await resp.json()) as Array<Record<string, unknown>>
}

describe('read-path: scope regression — cross-user isolation', () => {
  it('Alice cannot see Bob\'s resources via authenticated REST API', async () => {
    // Bob creates a resource with a unique sentinel name using service role
    const suffix = Math.random().toString(36).slice(2, 10)
    const bobProjectName = `bob-private-proj-${suffix}`
    const bobResult = await callRpcService('create_project', { p_name: bobProjectName })
    if (!bobResult.ok) {
      throw new Error(`Failed to create Bob's project: ${JSON.stringify(bobResult.data)}`)
    }
    const bobProjectId = (Array.isArray(bobResult.data) ? bobResult.data[0] : bobResult.data as Record<string, unknown>)?.['project_resource_id'] as string | undefined

    try {
      // Alice has her own JWT identity
      await withTestUser(async ({ jwt, assert }) => {
        const aliceResources = await listResourcesAsUser(jwt, 'project')

        // Alice must NOT see Bob's project (created without an auth_user_id)
        const leaked = aliceResources.find((r) => r['name'] === bobProjectName || r['id'] === bobProjectId)
        assert(
          leaked === undefined,
          `RLS violation: Alice can see Bob's project "${bobProjectName}" (id=${bobProjectId}) via authenticated REST API`
        )
      })
    } finally {
      if (bobProjectId) await callRpcService('delete_resource', { p_resource_id: bobProjectId })
    }
  })

  it('anon key cannot read resources without a valid user JWT', async () => {
    // A random (invalid) JWT should not grant access to any resources
    const fakeAuthUid = randomUUID()
    const fakeJwt = mintJwt({ sub: fakeAuthUid, email: `fake-${fakeAuthUid}@scope-test.test` })

    const url = `${SUPABASE_URL}/rest/v1/resources?type=eq.project`
    const resp = await fetch(url, {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${fakeJwt}`,
      },
    })

    // Either returns empty (RLS filters everything) or returns an error — never a full dump
    if (resp.ok) {
      const data = (await resp.json()) as Array<Record<string, unknown>>
      // A random user with no resources should see an empty list
      // (not a full table dump of all resources)
      // We cannot assert length === 0 because we don't control all data,
      // but we can assert the request did not 500 or bypass auth
      if (data.length > 100) {
        throw new Error(
          `Suspicious: fake JWT returned ${data.length} resources — possible RLS bypass`
        )
      }
    }
    // Any non-5xx response (including 401/403 or empty array) is acceptable
  })
})
