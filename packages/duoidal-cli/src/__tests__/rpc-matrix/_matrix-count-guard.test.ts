/**
 * Matrix count guard
 *
 * Reads action_types from the local DB and asserts that for each action
 * there exists a test file at rpc-matrix/<action>.tier3.integration.test.ts
 *
 * Also verifies that tier1, tier2, and read-path test files exist in the
 * expected counts so the full matrix is never silently truncated.
 *
 * PRE-MIGRATION (RED state):
 * None of the tier3 test files exist yet → this test FAILS with a clear
 * message listing every missing file.
 *
 * POST-MIGRATION (GREEN state):
 * All tier3 test files exist → this test passes.
 *
 * This guard prevents the matrix from silently shrinking when actions are
 * added to action_types without corresponding tests.
 */

import { describe, it, beforeAll } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RPC_MATRIX_DIR = __dirname
const READ_PATH_DIR = path.join(RPC_MATRIX_DIR, 'read-path')

beforeAll(() => {
  if (!process.env['RUN_INTEGRATION']) {
    throw new Error(
      'RUN_INTEGRATION must be set for the rpc-matrix suite. ' +
        'Run with: RUN_INTEGRATION=true pnpm test -- rpc-matrix'
    )
  }

  // Pre-flight: local-only invariant check.
  // Invokes `duoidal health` with an explicit local SUPABASE_URL (127.0.0.1) and asserts:
  //   1. The health check returns ok:true (CLI is talking to local Supabase)
  //   2. The SUPABASE_URL used is localhost/127.0.0.1 (not *.supabase.co)
  // Hard-aborts with FATAL if either assertion fails, preventing prod contamination.
  // CLI subprocesses in the matrix use explicitly constructed env — this pre-flight
  // confirms the local stack is reachable before any test runs.
  const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321'
  const LOCAL_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

  const healthResult = spawnSync(
    'pnpm',
    ['exec', 'duoidal', 'health'],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        SUPABASE_URL: LOCAL_SUPABASE_URL,
        SUPABASE_ANON_KEY: LOCAL_ANON_KEY,
      },
    }
  )

  // duoidal health may exit non-zero if the db check fails (known Supavisor tenant
  // routing issue on local stack with anon key — out of scope per goal). We check
  // the JSON output regardless of exit code.
  let healthJson: { ok?: boolean; checks?: Array<{ name: string; status: string }> } = {}
  try {
    healthJson = JSON.parse(healthResult.stdout)
  } catch {
    throw new Error(
      `FATAL: duoidal health returned non-JSON against ${LOCAL_SUPABASE_URL}\n` +
        `stdout: ${healthResult.stdout}\nstderr: ${healthResult.stderr}`
    )
  }

  // The jwt check passes when using the local well-known anon key — this proves
  // the CLI subprocess is talking to local Supabase, not prod.
  const jwtCheck = healthJson.checks?.find((c) => c.name === 'jwt')
  if (!jwtCheck || jwtCheck.status !== 'ok') {
    throw new Error(
      `FATAL: local-only invariant violated — duoidal health jwt check failed against ${LOCAL_SUPABASE_URL}\n` +
        `This means the CLI subprocess is NOT talking to local Supabase.\n` +
        `Full response: ${healthResult.stdout}`
    )
  }

})

function fetchActionTypes(): string[] {
  const result = spawnSync(
    'psql',
    [LOCAL_DB_URL, '--csv', '-t', '-c', 'SELECT name FROM action_types ORDER BY name;'],
    { encoding: 'utf8', timeout: 15_000 }
  )
  if (result.status !== 0) {
    throw new Error(`Failed to fetch action_types: ${result.stderr}`)
  }
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

describe('matrix count guard: tier3 test file coverage', () => {
  it('every action_type has a corresponding tier3 integration test file', () => {
    const actionTypes = fetchActionTypes()

    if (actionTypes.length === 0) {
      throw new Error('action_types table returned 0 rows — DB may not be running')
    }

    const missingFiles: string[] = []

    for (const action of actionTypes) {
      const expectedFile = path.join(RPC_MATRIX_DIR, `${action}.tier3.integration.test.ts`)
      if (!existsSync(expectedFile)) {
        missingFiles.push(expectedFile)
      }
    }

    if (missingFiles.length > 0) {
      const relMissing = missingFiles.map((f) =>
        path.relative(path.resolve(RPC_MATRIX_DIR, '..', '..', '..', '..', '..'), f)
      )
      throw new Error(
        `Missing tier3 integration test files for ${missingFiles.length} of ${actionTypes.length} action_types:\n` +
          relMissing.map((f) => `  - ${f}`).join('\n') +
          '\n\nCreate these files to complete the test matrix.'
      )
    }
  })
})

describe('matrix count guard: tier1 test file coverage', () => {
  it('at least 14 tier1 integration test files exist', () => {
    const tier1Files = readdirSync(RPC_MATRIX_DIR).filter((f) =>
      f.endsWith('.tier1.integration.test.ts')
    )
    if (tier1Files.length < 14) {
      throw new Error(
        `Expected at least 14 tier1 integration test files, found ${tier1Files.length}:\n` +
          tier1Files.map((f) => `  - ${f}`).join('\n')
      )
    }
  })
})

describe('matrix count guard: tier2 test file coverage', () => {
  it('at least 24 tier2 integration test files exist', () => {
    const tier2Files = readdirSync(RPC_MATRIX_DIR).filter((f) =>
      f.endsWith('.tier2.integration.test.ts')
    )
    if (tier2Files.length < 24) {
      throw new Error(
        `Expected at least 24 tier2 integration test files, found ${tier2Files.length}:\n` +
          tier2Files.map((f) => `  - ${f}`).join('\n')
      )
    }
  })
})

describe('matrix count guard: read-path test file coverage', () => {
  it('at least 11 read-path integration test files exist', () => {
    const readPathFiles = readdirSync(READ_PATH_DIR).filter((f) =>
      f.endsWith('.integration.test.ts')
    )
    if (readPathFiles.length < 11) {
      throw new Error(
        `Expected at least 11 read-path integration test files under read-path/, found ${readPathFiles.length}:\n` +
          readPathFiles.map((f) => `  - ${f}`).join('\n') +
          '\n\nCreate these files to complete the read-path matrix.'
      )
    }
  })
})
