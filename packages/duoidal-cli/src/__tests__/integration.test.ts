/**
 * Integration tests: CLI command behaviour
 *
 * Runs against the locally-built duoidal binary via pnpm exec.
 * Tests 1-3 require DATABASE_URL (and test 3 also requires EVAL_PROCESS_ID).
 * Tests 4-7 are structural — they only verify CLI help output, no DB needed.
 *
 * Requires: RUN_INTEGRATION=true (explicit opt-in)
 *
 * Usage:
 *   doppler run -- bash -c 'RUN_INTEGRATION=true npx vitest run packages/duoidal-cli/src/__tests__/integration.test.ts --reporter=verbose'
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')

function run(cmd: string, args: string[], timeoutMs = 10_000) {
  return spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env },
  })
}

// ---------------------------------------------------------------------------
// All tests are gated behind RUN_INTEGRATION=true
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.RUN_INTEGRATION)('duoidal CLI — integration', () => {
  // -------------------------------------------------------------------------
  // Test 1: `pnpm exec duoidal resource list` exits 0 within 3 seconds
  // Verifies: process terminates cleanly — no hung DB connection
  // Requires: DATABASE_URL
  // -------------------------------------------------------------------------
  it('resource list exits 0 within 3 seconds (no hung DB connection)', () => {
    if (!process.env.DATABASE_URL) {
      console.log('[integration] Skipping test 1: DATABASE_URL not set')
      return
    }

    const start = Date.now()
    const result = run('pnpm', ['exec', 'duoidal', 'resource', 'list'], 5_000)
    const elapsed = Date.now() - start

    expect(result.status, `exit code — stderr: ${result.stderr}`).toBe(0)
    expect(elapsed).toBeLessThan(3_000)
  })

  // -------------------------------------------------------------------------
  // Test 2: `pnpm exec agent-core resource list` output is byte-for-byte
  //         identical to `pnpm exec duoidal resource list`
  // Requires: DATABASE_URL
  // -------------------------------------------------------------------------
  it('agent-core resource list output matches duoidal resource list', () => {
    if (!process.env.DATABASE_URL) {
      console.log('[integration] Skipping test 2: DATABASE_URL not set')
      return
    }

    const duoidalResult = run('pnpm', ['exec', 'duoidal', 'resource', 'list'])
    const agentCoreResult = run('pnpm', ['exec', 'agent-core', 'resource', 'list'])

    expect(duoidalResult.status, `duoidal exit code — stderr: ${duoidalResult.stderr}`).toBe(0)
    expect(agentCoreResult.status, `agent-core exit code — stderr: ${agentCoreResult.stderr}`).toBe(0)
    expect(agentCoreResult.stdout).toBe(duoidalResult.stdout)
  })

  // -------------------------------------------------------------------------
  // Test 3: `pnpm exec duoidal process status --id <EVAL_PROCESS_ID> --json`
  //         returns valid JSON with an `id` field
  // Requires: DATABASE_URL + EVAL_PROCESS_ID
  // -------------------------------------------------------------------------
  it('process status --json returns valid JSON with an id field', () => {
    if (!process.env.DATABASE_URL) {
      console.log('[integration] Skipping test 3: DATABASE_URL not set')
      return
    }
    if (!process.env.EVAL_PROCESS_ID) {
      console.log('[integration] Skipping test 3: EVAL_PROCESS_ID not set')
      return
    }

    const result = run('pnpm', [
      'exec', 'duoidal',
      'process', 'status',
      '--id', process.env.EVAL_PROCESS_ID,
      '--json',
    ])

    expect(result.status, `exit code — stderr: ${result.stderr}`).toBe(0)

    let parsed: unknown
    expect(() => { parsed = JSON.parse(result.stdout) }).not.toThrow()
    expect((parsed as Record<string, unknown>).id).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Test 4: `pnpm exec duoidal sandbox link --help` exits 0 and stdout
  //         contains "provider"
  // -------------------------------------------------------------------------
  it('sandbox link --help exits 0 and stdout contains "provider"', () => {
    const result = run('pnpm', ['exec', 'duoidal', 'sandbox', 'link', '--help'])

    expect(result.status, `exit code — stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('provider')
  })

  // -------------------------------------------------------------------------
  // Test 5: `pnpm exec duoidal link` (removed top-level command) exits
  //         non-zero and output contains an error indicating removal/unknown
  // -------------------------------------------------------------------------
  it('duoidal link (removed command) exits non-zero with unknown command error', () => {
    const result = run('pnpm', ['exec', 'duoidal', 'link'])
    const combinedOutput = result.stdout + result.stderr

    expect(result.status).not.toBe(0)
    // Accept any phrasing that indicates the command is not recognised
    const indicatesUnknown =
      /unknown command/i.test(combinedOutput) ||
      /not found/i.test(combinedOutput) ||
      /invalid/i.test(combinedOutput) ||
      /error/i.test(combinedOutput)
    expect(indicatesUnknown, `expected error output, got: ${combinedOutput}`).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Test 6: `pnpm exec duoidal process init --help` exits 0
  // -------------------------------------------------------------------------
  it('process init --help exits 0', () => {
    const result = run('pnpm', ['exec', 'duoidal', 'process', 'init', '--help'])

    expect(result.status, `exit code — stderr: ${result.stderr}`).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Test 7: `pnpm exec duoidal process run --help` exits 0
  // -------------------------------------------------------------------------
  it('process run --help exits 0', () => {
    const result = run('pnpm', ['exec', 'duoidal', 'process', 'run', '--help'])

    expect(result.status, `exit code — stderr: ${result.stderr}`).toBe(0)
  })
})
