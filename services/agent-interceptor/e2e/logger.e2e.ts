/**
 * E2E test: verifies that agent-interceptor writes a log entry to the database on startup.
 *
 * Strategy:
 *   1. Record a startTime before spawning the process.
 *   2. Spawn the real node.ts entrypoint as a real subprocess (not imported).
 *      Uses the same node --require/--import tsx invocation pattern as production.
 *   3. Poll /health until 200 (proves the server is up and has already called logger.info).
 *   4. Wait for DB flush BEFORE killing (logger.info is fire-and-forget; must let it land).
 *   5. Kill the subprocess.
 *   6. Query logs WHERE service = 'webhook' AND timestamp >= startTime.
 *   7. Assert at least one row exists, print rows as JSON, exit 0.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import postgres from 'postgres'

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  process.stderr.write('FAIL: DATABASE_URL env var is required\n')
  process.exit(1)
}

const TEST_RUN_ID = randomUUID()
// Use a different port to avoid collision with any already-running interceptor instance
const PORT = 3199
const HEALTH_URL = `http://localhost:${PORT}/health`
const HEALTH_POLL_INTERVAL_MS = 500
const HEALTH_TIMEOUT_MS = 20_000
// Wait BEFORE killing to allow the async DB write to complete
const FLUSH_WAIT_MS = 4_000

async function pollHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL)
      if (res.status === 200) return
    } catch {
      // Server not yet up — keep polling
    }
    await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms`)
}

async function main(): Promise<void> {
  const startTime = new Date()
  process.stdout.write(`[e2e] test run ${TEST_RUN_ID}\n`)
  process.stdout.write(`[e2e] start time: ${startTime.toISOString()}\n`)

  // Resolve repo root from the cwd (this test is invoked from repo root)
  const repoRoot = process.cwd()
  const serviceDir = resolve(repoRoot, 'services/agent-interceptor')
  const tsxPreflight = resolve(repoRoot, 'node_modules/tsx/dist/preflight.cjs')
  const tsxLoader = resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs')
  // Add service node_modules to NODE_PATH so @hono/node-server resolves
  // when the subprocess runs from repoRoot (for config.yaml discovery).
  const serviceNodeModules = resolve(serviceDir, 'node_modules')

  // Spawn agent-interceptor as a real subprocess — NOT imported.
  // Use the same invocation pattern as production (node --require/--import tsx hooks).
  // Running from repoRoot so config.yaml is discovered at the correct location.
  // NODE_PATH includes service node_modules for @hono/node-server resolution.
  const child = spawn(
    process.execPath,
    [
      '--require', tsxPreflight,
      '--import', `file://${tsxLoader}`,
      'services/agent-interceptor/src/entrypoints/node.ts',
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL,
        PORT: String(PORT),
        E2E_SESSION_TAG: TEST_RUN_ID,
        NODE_PATH: serviceNodeModules,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: repoRoot,
    }
  )

  child.stdout?.on('data', (d: Buffer) => {
    process.stderr.write(`[interceptor:out] ${d.toString()}`)
  })
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[interceptor:err] ${d.toString()}`)
  })

  let exitCode = 0

  try {
    process.stdout.write(`[e2e] waiting for ${HEALTH_URL} to return 200...\n`)
    await pollHealth(HEALTH_TIMEOUT_MS)
    process.stdout.write(`[e2e] health check passed\n`)

    // Make an explicit GET request to confirm the server responds
    const healthRes = await fetch(HEALTH_URL)
    process.stdout.write(`[e2e] GET /health -> ${healthRes.status}\n`)

    // Wait for DB writes to flush BEFORE killing the subprocess — the startup
    // logger.info() is fire-and-forget; if we kill immediately the in-flight
    // INSERT is abandoned.
    process.stdout.write(`[e2e] waiting ${FLUSH_WAIT_MS}ms for DB flush before shutdown...\n`)
    await new Promise(r => setTimeout(r, FLUSH_WAIT_MS))

  } finally {
    child.kill('SIGTERM')
    process.stdout.write(`[e2e] subprocess killed\n`)
  }

  // Query the DB for log rows written by this run
  const sql = postgres(DATABASE_URL)
  try {
    const rows = await sql`
      SELECT id, level, service, message, timestamp, data
      FROM logs
      WHERE service = 'webhook'
        AND timestamp >= ${startTime}
      ORDER BY timestamp ASC
    `

    await sql.end()

    process.stdout.write(`[e2e] rows found: ${rows.length}\n`)
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n')

    if (rows.length === 0) {
      process.stderr.write('FAIL: no log rows found in DB for this run\n')
      exitCode = 1
    } else {
      process.stdout.write('PASS\n')
    }
  } catch (err) {
    await sql.end().catch(() => {})
    throw err
  }

  process.exit(exitCode)
}

main().catch(err => {
  process.stderr.write(`FAIL: ${String(err)}\n`)
  process.exit(1)
})
