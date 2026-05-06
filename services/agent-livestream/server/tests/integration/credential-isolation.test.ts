/**
 * @group integration
 *
 * Credential Isolation Integration Test — Story 1
 *
 * Tests get_user_credential and get_user_credential_for RPCs against real Postgres.
 * Proves cross-user isolation: user A's JWT cannot retrieve user B's credentials.
 *
 * Run with:
 *   SUPABASE_URL=$SUPABASE_URL SUPABASE_SERVICE_KEY=$SUPABASE_SERVICE_KEY \
 *   RUN_INTEGRATION=true npx vitest run services/agent-livestream/server/tests/integration/credential-isolation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'

// --- Environment -----------------------------------------------------------

const DATABASE_URL = process.env['DATABASE_URL'] ?? process.env['SKILL_NETWORKS_DATABASE_URL']
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === 'true' || !!DATABASE_URL

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute get_user_credential RPC as a specific user UUID by setting
 * request.jwt.claims in the session (simulates Supabase auth.uid()).
 */
async function callGetUserCredential(
  sql: postgres.Sql,
  authUid: string,
  credentialName: string,
): Promise<Array<{ credential_id: string; secret: string; metadata: unknown }>> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: authUid })}, true)`
    const rows = await tx<Array<{ credential_id: string; secret: string; metadata: unknown }>>`
      SELECT credential_id, secret, metadata
      FROM public.get_user_credential(${credentialName}, ${authUid}::uuid)
    `
    return rows
  })
}

/**
 * Execute get_user_credential_for RPC as a specific user UUID.
 */
async function callGetUserCredentialFor(
  sql: postgres.Sql,
  authUid: string,
  resourceId: string,
  linkType: string,
): Promise<Array<{ credential_id: string; secret: string; metadata: unknown }>> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: authUid })}, true)`
    const rows = await tx<Array<{ credential_id: string; secret: string; metadata: unknown }>>`
      SELECT credential_id, secret, metadata
      FROM public.get_user_credential_for(${resourceId}::uuid, ${linkType}, ${authUid}::uuid)
    `
    return rows
  })
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)('credential isolation: get_user_credential RPCs', () => {
  let sql: postgres.Sql

  // Test state
  let userAUid: string
  let userBUid: string
  let userAResourceId: string
  let userBResourceId: string
  let credAVaultId: string
  let credBVaultId: string
  let credAResourceId: string
  let credBResourceId: string
  let serverBResourceId: string

  const TEST_PREFIX = `ci-test-${Date.now()}`
  const CRED_A_NAME = `${TEST_PREFIX}-user-a-cloudflare`
  const CRED_B_NAME = `${TEST_PREFIX}-user-b-cloudflare`
  const CRED_A_SECRET = `secret-for-user-a-${Date.now()}`
  const CRED_B_SECRET = `secret-for-user-b-${Date.now()}`

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests')

    sql = postgres(DATABASE_URL)

    // Generate stable UUIDs for test users (not real auth.users rows — user resources
    // use the auth_user_id field but the name field is the lookup key for our RPCs)
    userAUid = crypto.randomUUID()
    userBUid = crypto.randomUUID()

    // 1. Create user resource for A
    const [userA] = await sql<[{ id: string }]>`
      INSERT INTO public.resources (name, type, status, config)
      VALUES (${'user:' + userAUid}, 'user', 'active', '{}')
      RETURNING id
    `
    userAResourceId = userA.id

    // 2. Create user resource for B
    const [userB] = await sql<[{ id: string }]>`
      INSERT INTO public.resources (name, type, status, config)
      VALUES (${'user:' + userBUid}, 'user', 'active', '{}')
      RETURNING id
    `
    userBResourceId = userB.id

    // 3. Store credential for A in vault
    const [vaultA] = await sql<[{ id: string }]>`
      SELECT vault.create_secret(${CRED_A_SECRET}, ${`vault-${TEST_PREFIX}-a`}) AS id
    `
    credAVaultId = vaultA.id

    // 4. Create credential resource for A
    const [credA] = await sql<[{ id: string }]>`
      INSERT INTO public.resources (name, type, status, config)
      VALUES (
        ${CRED_A_NAME},
        'credential',
        'active',
        ${sql.json({ vaultSecretId: credAVaultId, provider: 'cloudflare', sandboxName: 'test' })}
      )
      RETURNING id
    `
    credAResourceId = credA.id

    // 5. Link A's credential to A's user resource via 'parent'
    await sql`
      INSERT INTO public.resource_links (from_id, to_id, link_type)
      VALUES (${credAResourceId}, ${userAResourceId}, 'parent')
    `

    // 6. Store credential for B in vault
    const [vaultB] = await sql<[{ id: string }]>`
      SELECT vault.create_secret(${CRED_B_SECRET}, ${`vault-${TEST_PREFIX}-b`}) AS id
    `
    credBVaultId = vaultB.id

    // 7. Create credential resource for B
    const [credB] = await sql<[{ id: string }]>`
      INSERT INTO public.resources (name, type, status, config)
      VALUES (
        ${CRED_B_NAME},
        'credential',
        'active',
        ${sql.json({ vaultSecretId: credBVaultId, provider: 'cloudflare-b', sandboxName: 'test' })}
      )
      RETURNING id
    `
    credBResourceId = credB.id

    // 8. Link B's credential to B's user resource via 'parent'
    await sql`
      INSERT INTO public.resource_links (from_id, to_id, link_type)
      VALUES (${credBResourceId}, ${userBResourceId}, 'parent')
    `

    // 9. Create a server resource owned by B (for get_user_credential_for test)
    const [serverB] = await sql<[{ id: string }]>`
      INSERT INTO public.resources (name, type, status, config)
      VALUES (${`${TEST_PREFIX}-server-b`}, 'server', 'active', '{}')
      RETURNING id
    `
    serverBResourceId = serverB.id

    // 10. Link B's server to B's user resource via 'parent'
    await sql`
      INSERT INTO public.resource_links (from_id, to_id, link_type)
      VALUES (${serverBResourceId}, ${userBResourceId}, 'parent')
    `

    // 11. Link B's credential to B's server via 'accesses'
    await sql`
      INSERT INTO public.resource_links (from_id, to_id, link_type)
      VALUES (${credBResourceId}, ${serverBResourceId}, 'accesses')
    `
  }, 30_000)

  afterAll(async () => {
    if (!sql) return

    // Clean up all resource_links for test resources
    const testIds = [
      credAResourceId,
      credBResourceId,
      serverBResourceId,
      userAResourceId,
      userBResourceId,
    ].filter(Boolean)

    for (const id of testIds) {
      await sql`DELETE FROM public.resource_links WHERE from_id = ${id} OR to_id = ${id}`
    }

    // Delete credential resources (cascade-safe order: credentials first, then users/servers)
    if (credAResourceId) await sql`DELETE FROM public.resources WHERE id = ${credAResourceId}`
    if (credBResourceId) await sql`DELETE FROM public.resources WHERE id = ${credBResourceId}`
    if (serverBResourceId) await sql`DELETE FROM public.resources WHERE id = ${serverBResourceId}`
    if (userAResourceId) await sql`DELETE FROM public.resources WHERE id = ${userAResourceId}`
    if (userBResourceId) await sql`DELETE FROM public.resources WHERE id = ${userBResourceId}`

    // Delete vault secrets
    if (credAVaultId) await sql`DELETE FROM vault.secrets WHERE id = ${credAVaultId}`
    if (credBVaultId) await sql`DELETE FROM vault.secrets WHERE id = ${credBVaultId}`

    await sql.end()
  }, 30_000)

  // ── Test 1: User A retrieves their own credential ──────────────────────────

  it("get_user_credential with user A's JWT returns A's credential", async () => {
    const rows = await callGetUserCredential(sql, userAUid, CRED_A_NAME)
    expect(rows).toHaveLength(1)
    expect(rows[0].secret).toBe(CRED_A_SECRET)
    expect(rows[0].credential_id).toBe(credAResourceId)
  })

  // ── Test 2: User A cannot retrieve B's credential by name ─────────────────

  it("get_user_credential with user A's JWT asking for B's credential name returns empty", async () => {
    const rows = await callGetUserCredential(sql, userAUid, CRED_B_NAME)
    expect(rows).toHaveLength(0)
  })

  // ── Test 3: User B retrieves their own credential ──────────────────────────

  it("get_user_credential with user B's JWT returns B's credential", async () => {
    const rows = await callGetUserCredential(sql, userBUid, CRED_B_NAME)
    expect(rows).toHaveLength(1)
    expect(rows[0].secret).toBe(CRED_B_SECRET)
    expect(rows[0].credential_id).toBe(credBResourceId)
  })

  // ── Test 4: get_user_credential_for: A's JWT on B's server returns empty ──

  it("get_user_credential_for(B's server, 'accesses') with A's JWT returns empty", async () => {
    const rows = await callGetUserCredentialFor(sql, userAUid, serverBResourceId, 'accesses')
    expect(rows).toHaveLength(0)
  })

  // ── Test 5: get_user_credential_for: B's JWT on B's server returns B's cred

  it("get_user_credential_for(B's server, 'accesses') with B's JWT returns B's credential", async () => {
    const rows = await callGetUserCredentialFor(sql, userBUid, serverBResourceId, 'accesses')
    expect(rows).toHaveLength(1)
    expect(rows[0].secret).toBe(CRED_B_SECRET)
    expect(rows[0].credential_id).toBe(credBResourceId)
  })

  // ── Test 6: Nonexistent user returns empty, not an error ──────────────────

  it('get_user_credential with a nonexistent user UUID returns empty without error', async () => {
    const fakeUid = '00000000-0000-0000-0000-ffffffffffff'
    const rows = await callGetUserCredential(sql, fakeUid, CRED_A_NAME)
    expect(rows).toHaveLength(0)
  })

  // ── Test 7: Accesses link type is registered ──────────────────────────────

  it("link type 'accesses' exists in link_types table", async () => {
    const [row] = await sql<[{ name: string }]>`
      SELECT name FROM public.link_types WHERE name = 'accesses'
    `
    expect(row?.name).toBe('accesses')
  })
})
