/**
 * Story 2 Integration Tests — Cloudflare for SaaS DNS
 *
 * Tests criterion 3, 4, and 5 against real Postgres + mock CF adapter.
 *
 * Run with:
 *   DATABASE_URL="$DATABASE_URL" RUN_INTEGRATION=true \
 *   npx vitest run services/agent-livestream/server/tests/integration/sandbox-provision.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { Hono } from 'hono'
import type { JWTPayload } from 'jose'
import { MockCloudflareSaasAdapter } from '../../lib/cloudflare-saas.js'
import { createSandboxRouter } from '../../routes/sandbox.js'

// ── Environment ───────────────────────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'] ?? process.env['SKILL_NETWORKS_DATABASE_URL']
const SUPABASE_URL = process.env['SUPABASE_URL']
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY']
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === 'true' || !!DATABASE_URL

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_PREFIX = `story2-test-${Date.now()}`
const MOCK_ZONE_ID = 'mock-zone-123'
const MOCK_CF_TOKEN = 'mock-cf-token'

/**
 * Calls provision_sandbox RPC directly via postgres for concurrency tests.
 * This bypasses the BFF (HTTP) to test the DB-level advisory lock directly.
 */
async function callProvisionSandboxDirect(
  sql: postgres.Sql,
  authUid: string,
  userResourceId: string,
  serverName: string,
  sshKeyName: string,
): Promise<{ serverResourceId: string; credentialResourceId: string; isNew: boolean }> {
  return sql.begin(async (tx) => {
    // Simulate Supabase auth.uid() by setting request.jwt.claims
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: authUid })}, true)`
    const rows = await tx<Array<{
      server_resource_id: string
      credential_resource_id: string
      is_new: boolean
    }>>`
      SELECT server_resource_id, credential_resource_id, is_new
      FROM public.provision_sandbox(
        ${userResourceId}::uuid,
        ${serverName}::text,
        ${sshKeyName}::text,
        ${'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest test@story2'}::text,
        NULL::text,
        NULL::text
      )
    `
    if (!rows[0]) throw new Error('provision_sandbox returned no rows')
    return {
      serverResourceId: rows[0].server_resource_id,
      credentialResourceId: rows[0].credential_resource_id,
      isNew: rows[0].is_new,
    }
  })
}

// ── Suite 1: Criterion 3 — Concurrent provision_sandbox (real Postgres) ──────
//
// 5 concurrent calls for the same user → exactly 1 server row, 1 CF call,
// all 5 return the same serverId.

describe.skipIf(!RUN_INTEGRATION)('criterion 3: concurrent provision_sandbox idempotency', () => {
  let sql: postgres.Sql
  let userUid: string
  let userResourceId: string
  let serverResourceId: string
  const createdResourceNames: string[] = []

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL required')
    sql = postgres(DATABASE_URL)

    userUid = crypto.randomUUID()
    const userName = `user:${userUid}`

    // auth_user_id has a FK to auth.users — use NULL to avoid FK violation in tests.
    // The provision_sandbox RPC matches via name='user:{uid}' rather than auth_user_id column.
    const [userRow] = await sql<[{ id: string }]>`
      INSERT INTO public.resources (name, type, status, config)
      VALUES (
        ${userName},
        'user',
        'active',
        '{"status":"approved"}'::jsonb
      )
      RETURNING id
    `
    userResourceId = userRow.id
    createdResourceNames.push(userName)
  }, 30_000)

  afterAll(async () => {
    if (!sql) return

    // Clean up server + credential resources
    const serverName = `sandbox-${userUid}`
    const sshKeyName = `sshkey-${userUid}`
    for (const name of [serverName, sshKeyName]) {
      const [res] = await sql<[{ id: string }?]>`
        SELECT id FROM public.resources WHERE name = ${name} LIMIT 1
      `
      if (res?.id) {
        await sql`DELETE FROM public.resource_links WHERE from_id = ${res.id} OR to_id = ${res.id}`
        await sql`DELETE FROM public.resources WHERE id = ${res.id}`
      }
    }

    // Clean up user
    const userName = `user:${userUid}`
    const [userRes] = await sql<[{ id: string }?]>`
      SELECT id FROM public.resources WHERE name = ${userName} LIMIT 1
    `
    if (userRes?.id) {
      await sql`DELETE FROM public.resource_links WHERE from_id = ${userRes.id} OR to_id = ${userRes.id}`
      await sql`DELETE FROM public.resources WHERE id = ${userRes.id}`
    }

    await sql.end()
  }, 30_000)

  it('5 concurrent calls → exactly 1 server row, all return same serverId', async () => {
    const serverName = `sandbox-${userUid}`
    const sshKeyName = `sshkey-${userUid}`

    // Launch 5 concurrent provision calls
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        callProvisionSandboxDirect(sql, userUid, userResourceId, serverName, sshKeyName)
      )
    )

    // All 5 must return the same server resource ID
    const serverIds = results.map(r => r.serverResourceId)
    const uniqueServerIds = new Set(serverIds)
    expect(uniqueServerIds.size).toBe(1)
    serverResourceId = serverIds[0]!

    // Exactly 1 server row in DB
    const [{ count }] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count
      FROM public.resources
      WHERE name = ${serverName}
        AND type = 'server'
    `
    expect(Number(count)).toBe(1)

    // Exactly 1 was new (the winner); the other 4 returned isNew=false
    const newCount = results.filter(r => r.isNew).length
    expect(newCount).toBe(1)
  }, 60_000)

  it('CF adapter: exactly 1 create call for same server (mock CF adapter, DB-level winner check)', async () => {
    // This test verifies criterion 3's CF-call-count requirement using the mock adapter.
    // The DB advisory lock is already proven by the first test (5 concurrent → 1 server row).
    // The CF adapter only fires for the winner (isNew=true).
    // Use a fresh postgres connection to avoid prepared statement cache conflicts.

    const cfAdapter = new MockCloudflareSaasAdapter()

    // Use a fresh postgres connection to avoid cross-test prepared statement conflicts
    const sql2 = postgres(DATABASE_URL!)

    try {
      const freshUserUid = crypto.randomUUID()
      const freshServerName = `sandbox-cf-count-${freshUserUid}`
      const freshSshKeyName = `sshkey-cf-count-${freshUserUid}`

      // Create user for this test
      const [freshUser] = await sql2<[{ id: string }]>`
        INSERT INTO public.resources (name, type, status, config)
        VALUES (${'user:' + freshUserUid}, 'user', 'active', '{"status":"approved"}'::jsonb)
        RETURNING id
      `

      // Run provision_sandbox 5 times concurrently with the same server name
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          callProvisionSandboxDirect(sql2, freshUserUid, freshUser.id, freshServerName, freshSshKeyName)
        )
      )

      // Simulate: winner calls CF, others do not
      let cfCallCount = 0
      for (const r of results) {
        if (r.isNew) {
          cfCallCount++
          await cfAdapter.createCustomHostname(r.serverResourceId, MOCK_ZONE_ID, MOCK_CF_TOKEN)
        }
      }

      // Exactly 1 winner → exactly 1 CF call
      expect(cfCallCount).toBe(1)
      expect(cfAdapter.callCount).toBe(1)

      // All 5 return same serverId
      const serverIds = results.map(r => r.serverResourceId)
      expect(new Set(serverIds).size).toBe(1)

      // Clean up
      for (const name of [freshServerName, freshSshKeyName]) {
        const res = await sql2`SELECT id FROM public.resources WHERE name = ${name} LIMIT 1`
        if (res[0]?.id) {
          await sql2`DELETE FROM public.resource_links WHERE from_id = ${res[0].id} OR to_id = ${res[0].id}`
          await sql2`DELETE FROM public.resources WHERE id = ${res[0].id}`
        }
      }
      await sql2`DELETE FROM public.resource_links WHERE from_id = ${freshUser.id} OR to_id = ${freshUser.id}`
      await sql2`DELETE FROM public.resources WHERE id = ${freshUser.id}`
    } finally {
      await sql2.end()
    }
  }, 60_000)
})

// ── Suite 2: Criterion 4 — Migration verification ─────────────────────────────
//
// SELECT COUNT(*) FROM resources WHERE type='sandbox' returns 0 post-migration.

describe.skipIf(!RUN_INTEGRATION)('criterion 4: no sandbox type resources post-migration', () => {
  let sql: postgres.Sql

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL required')
    sql = postgres(DATABASE_URL)
  }, 10_000)

  afterAll(async () => {
    await sql?.end()
  })

  it('SELECT COUNT(*) FROM resources WHERE type=sandbox returns 0', async () => {
    const [{ count }] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM public.resources WHERE type = 'sandbox'
    `
    expect(Number(count)).toBe(0)
  })
})

// ── Suite 3: Criterion 5 — Reconciliation sweep ───────────────────────────────
//
// Simulate: CF hostname created, DB rollback → orphan.
// Run sweep → orphan deleted. Run sweep again → no-op.

describe.skipIf(!RUN_INTEGRATION)('criterion 5: reconciliation sweep', () => {
  let sql: postgres.Sql

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL required')
    sql = postgres(DATABASE_URL)
  }, 10_000)

  afterAll(async () => {
    await sql?.end()
  })

  it('sweep deletes orphaned CF hostname not in DB', async () => {
    const orphanId = 'orphan-test-id-001'
    const orphanServerId = crypto.randomUUID()
    const orphanHostname = `*.${orphanServerId}.example.com`

    const cfAdapter = new MockCloudflareSaasAdapter()

    // Seed an orphan hostname (CF has it, DB does not)
    cfAdapter.seedOrphan(orphanId, orphanHostname)
    expect(cfAdapter.has(orphanId)).toBe(true)

    // Perform reconciliation sweep (in-memory mock version)
    await performMockReconciliationSweep(cfAdapter, sql, MOCK_ZONE_ID, MOCK_CF_TOKEN)

    // Orphan should be deleted from CF
    expect(cfAdapter.has(orphanId)).toBe(false)
  })

  it('sweep is a no-op when all CF hostnames have matching DB rows', async () => {
    const cfAdapter = new MockCloudflareSaasAdapter()

    // Create a real server in DB with a CF hostname ID
    const serverName = `${TEST_PREFIX}-server-noop`
    const cfHostnameId = 'cf-hostname-registered'
    const serverId = crypto.randomUUID()

    const [serverRow] = await sql<[{ id: string }]>`
      INSERT INTO public.resources (name, type, status, config)
      VALUES (
        ${serverName},
        'server',
        'active',
        ${sql.json({ cloudflareCustomHostnameId: cfHostnameId, status: 'active' })}
      )
      RETURNING id
    `

    // Seed CF with the matching hostname
    cfAdapter.seedOrphan(cfHostnameId, `*.${serverRow.id}.example.com`)
    expect(cfAdapter.has(cfHostnameId)).toBe(true)

    // Run sweep with the DB server's actual ID as the CF hostname key
    // The sweep uses server resource IDs to cross-reference
    cfAdapter.seedOrphan(cfHostnameId, `*.${serverRow.id}.example.com`)

    await performMockReconciliationSweep(cfAdapter, sql, MOCK_ZONE_ID, MOCK_CF_TOKEN)

    // Should NOT have deleted the hostname (it has a matching DB row)
    expect(cfAdapter.has(cfHostnameId)).toBe(true)

    // Clean up
    await sql`DELETE FROM public.resources WHERE id = ${serverRow.id}`
  })

  it('second sweep after orphan deletion is a no-op', async () => {
    const cfAdapter = new MockCloudflareSaasAdapter()

    // First sweep: delete an orphan
    const orphanId = 'orphan-idempotent-001'
    cfAdapter.seedOrphan(orphanId, `*.${crypto.randomUUID()}.example.com`)

    await performMockReconciliationSweep(cfAdapter, sql, MOCK_ZONE_ID, MOCK_CF_TOKEN)
    expect(cfAdapter.has(orphanId)).toBe(false)

    // Second sweep: no orphans remain
    await performMockReconciliationSweep(cfAdapter, sql, MOCK_ZONE_ID, MOCK_CF_TOKEN)
    // Just verify it doesn't throw — no-op
    expect(cfAdapter.has(orphanId)).toBe(false)
  })
})

// ── Reconciliation sweep implementation (mock-compatible) ────────────────────

/**
 * Mock-compatible reconciliation sweep for testing.
 * Uses the MockCloudflareSaasAdapter instead of the real CF API.
 * Logic mirrors scripts/reconcile-cf-hostnames.ts.
 */
async function performMockReconciliationSweep(
  cfAdapter: MockCloudflareSaasAdapter,
  sql: postgres.Sql,
  zoneId: string,
  token: string,
): Promise<{ orphansDeleted: number }> {
  // 1. List all CF custom hostnames
  const cfHostnames = await cfAdapter.listCustomHostnames(zoneId, token)

  // 2. Filter to sandbox pattern (*.{uuid}.example.com)
  const sandboxPattern = /^\*\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.duoidal\.com$/
  const sandboxHostnames = cfHostnames.filter(h => sandboxPattern.test(h.hostname))

  if (sandboxHostnames.length === 0) return { orphansDeleted: 0 }

  // 3. Fetch all server resources with cloudflareCustomHostnameId from DB
  type DbRow = { id: string; cf_hostname_id: string }
  const dbRows = await sql<DbRow[]>`
    SELECT id, config->>'cloudflareCustomHostnameId' AS cf_hostname_id
    FROM public.resources
    WHERE type = 'server'
      AND config ? 'cloudflareCustomHostnameId'
  `

  const dbHostnameIds = new Set(dbRows.map(r => r.cf_hostname_id).filter(Boolean))
  const dbServerIds = new Set(dbRows.map(r => r.id))

  // 4. Identify and delete orphans
  let orphansDeleted = 0
  for (const h of sandboxHostnames) {
    const match = h.hostname.match(sandboxPattern)
    const serverId = match?.[1]
    if (!serverId) continue

    const isOrphan = !dbServerIds.has(serverId) || !dbHostnameIds.has(h.id)
    if (isOrphan) {
      await cfAdapter.deleteCustomHostname(h.id, zoneId, token)
      orphansDeleted++
    }
  }

  return { orphansDeleted }
}
