/**
 * Core harness for rpc-matrix integration tests.
 *
 * Key behaviors:
 * - Uses direct postgres connection (port 54322) for admin operations
 * - withTestUser: inserts auth.users row + resources row, yields jwt + runCli + assert
 * - runCli: spawns pnpm exec duoidal subprocess with EXPLICIT env (never process.env passthrough)
 * - assertionsMade gate: fn receives an `assert` helper; throws if no assertions made
 * - Cleanup: delete resources row then auth.users row in finally block
 * - Global afterAll: sweep for leaked test users (email LIKE '%@rpc-matrix.test')
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { mintJwt } from './_mint-jwt.js'

// ---------------------------------------------------------------------------
// RUN_INTEGRATION gate — hard fail if not set
// ---------------------------------------------------------------------------
beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error(
      'RUN_INTEGRATION must be set for the rpc-matrix suite. ' +
        'Run with: RUN_INTEGRATION=true pnpm test -- rpc-matrix'
    )
  }
})

// ---------------------------------------------------------------------------
// Local Supabase env constants — NEVER read from process.env for these
// ---------------------------------------------------------------------------
const LOCAL_SUPABASE_ENV = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  SUPABASE_SERVICE_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
} as const

const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')

// ---------------------------------------------------------------------------
// DB admin helpers — use psql subprocess to avoid needing pg in devDeps
// ---------------------------------------------------------------------------

function runPsql(sql: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('psql', [LOCAL_DB_URL, '-c', sql], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  }
}

function runPsqlQuery<T>(sql: string): T[] {
  const result = spawnSync('psql', [LOCAL_DB_URL, '--csv', '-t', '-c', sql], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0) {
    throw new Error(`psql query failed: ${result.stderr}\nSQL: ${sql}`)
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  // For simple single-column queries, return the values directly
  return lines as unknown as T[]
}

// ---------------------------------------------------------------------------
// Test context interface
// ---------------------------------------------------------------------------

export interface CliResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface TestContext {
  authUid: string
  resourceId: string
  jwt: string
  runCli: (args: string[]) => CliResult
  assert: (condition: boolean, message?: string) => void
}

// ---------------------------------------------------------------------------
// runCli: spawns duoidal subprocess with EXPLICIT env (no process.env passthrough)
// ---------------------------------------------------------------------------

function makeCliRunner(jwt: string): (args: string[]) => CliResult {
  return (args: string[]): CliResult => {
    // Construct env explicitly — NEVER spread process.env
    const explicitEnv: Record<string, string> = {
      ...LOCAL_SUPABASE_ENV,
      DUOIDAL_TOKEN: jwt,
      // Minimal system env vars required for process execution
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '/root',
      NODE_ENV: 'test',
    }

    const result = spawnSync('pnpm', ['exec', 'duoidal', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: explicitEnv,
    })

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status,
    }
  }
}

// ---------------------------------------------------------------------------
// insertAuthUser: insert into auth.users directly via psql
// ---------------------------------------------------------------------------

function insertAuthUser(authUid: string, email: string): void {
  const now = new Date().toISOString()
  const sql = `
    INSERT INTO auth.users (
      id, email, aud, role,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      is_sso_user, is_anonymous
    ) VALUES (
      '${authUid}',
      '${email}',
      'authenticated',
      'authenticated',
      '${now}',
      '${now}',
      '${now}',
      '{"provider":"email","providers":["email"]}',
      '{}',
      false,
      false
    );
  `
  const result = runPsql(sql)
  if (result.status !== 0) {
    throw new Error(`Failed to insert auth user: ${result.stderr}`)
  }
}

// ---------------------------------------------------------------------------
// insertResourceRow: create a resources row for the user
// (handle_new_auth_user trigger does not exist pre-migration)
// ---------------------------------------------------------------------------

function insertResourceRow(authUid: string, emailSuffix: string): string {
  const sql = `
    INSERT INTO resources (name, type, auth_user_id, config)
    VALUES ('user:test-${emailSuffix}', 'user', '${authUid}', '{}')
    RETURNING id;
  `
  const rows = runPsqlQuery<string>(sql)
  const resourceId = rows[0]?.trim()
  if (!resourceId) {
    throw new Error(`Failed to insert resource row for auth user ${authUid}`)
  }
  return resourceId
}

// ---------------------------------------------------------------------------
// cleanup helpers
// ---------------------------------------------------------------------------

function deleteResourceRow(resourceId: string): void {
  const result = runPsql(`DELETE FROM resources WHERE id = '${resourceId}';`)
  if (result.status !== 0) {
    console.warn(`[rpc-matrix] cleanup: failed to delete resource ${resourceId}: ${result.stderr}`)
  }
}

function deleteAuthUser(authUid: string): void {
  const result = runPsql(`DELETE FROM auth.users WHERE id = '${authUid}';`)
  if (result.status !== 0) {
    console.warn(`[rpc-matrix] cleanup: failed to delete auth user ${authUid}: ${result.stderr}`)
  }
}

// ---------------------------------------------------------------------------
// Global afterAll: sweep for leaked test users
// ---------------------------------------------------------------------------

afterAll(() => {
  // Find any leaked test users
  const rows = runPsqlQuery<string>(
    `SELECT id FROM auth.users WHERE email LIKE '%@rpc-matrix.test';`
  )
  for (const row of rows) {
    const uid = row.trim()
    if (uid) {
      console.warn(`[rpc-matrix] sweeping leaked test user: ${uid}`)
      // delete resources first (FK constraint)
      runPsql(`DELETE FROM resources WHERE auth_user_id = '${uid}';`)
      runPsql(`DELETE FROM auth.users WHERE id = '${uid}';`)
    }
  }
})

// ---------------------------------------------------------------------------
// withTestUser: main harness entry point
// ---------------------------------------------------------------------------

export async function withTestUser(
  fn: (ctx: TestContext) => Promise<void>
): Promise<void> {
  const authUid = randomUUID()
  const suffix = randomUUID().slice(0, 8)
  const email = `test-${suffix}@rpc-matrix.test`

  let resourceId: string | null = null

  const assert = (condition: boolean, message?: string): void => {
    if (!condition) {
      throw new Error(message ?? 'Assertion failed')
    }
  }

  insertAuthUser(authUid, email)

  try {
    resourceId = insertResourceRow(authUid, suffix)

    const jwt = mintJwt({ sub: authUid, email })
    const runCli = makeCliRunner(jwt)

    await fn({ authUid, resourceId, jwt, runCli, assert })
  } finally {
    if (resourceId) {
      deleteResourceRow(resourceId)
    }
    deleteAuthUser(authUid)
  }

}

// ---------------------------------------------------------------------------
// Supabase RPC helper: call a Supabase RPC with a given JWT
// Returns the fetch response as parsed JSON (or throws on error)
// ---------------------------------------------------------------------------

export interface RpcCallResult {
  ok: boolean
  status: number
  data: unknown
  error: string | null
}

export async function callRpc(
  rpcName: string,
  body: Record<string, unknown>,
  jwt: string
): Promise<RpcCallResult> {
  const url = `${LOCAL_SUPABASE_ENV.SUPABASE_URL}/rest/v1/rpc/${rpcName}`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: LOCAL_SUPABASE_ENV.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  })

  let data: unknown = null
  let error: string | null = null

  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as unknown
    if (!response.ok && parsed && typeof parsed === 'object' && 'message' in parsed) {
      error = String((parsed as Record<string, unknown>)['message'])
      data = parsed
    } else {
      data = parsed
    }
  } catch {
    data = text
    if (!response.ok) {
      error = text
    }
  }

  return { ok: response.ok, status: response.status, data, error }
}

// ---------------------------------------------------------------------------
// callRpcService: call a Supabase RPC with the service role key
// Used for admin-only RPCs that are not accessible to the authenticated role
// ---------------------------------------------------------------------------

export async function callRpcService(
  rpcName: string,
  body: Record<string, unknown>
): Promise<RpcCallResult> {
  const url = `${LOCAL_SUPABASE_ENV.SUPABASE_URL}/rest/v1/rpc/${rpcName}`
  const serviceKey = LOCAL_SUPABASE_ENV.SUPABASE_SERVICE_KEY
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  })

  let data: unknown = null
  let error: string | null = null

  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as unknown
    if (!response.ok && parsed && typeof parsed === 'object' && 'message' in parsed) {
      error = String((parsed as Record<string, unknown>)['message'])
      data = parsed
    } else {
      data = parsed
    }
  } catch {
    data = text
    if (!response.ok) {
      error = text
    }
  }

  return { ok: response.ok, status: response.status, data, error }
}
