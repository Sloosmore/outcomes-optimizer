#!/usr/bin/env npx tsx
/**
 * Measure wall-clock time from `duoidal execute` invocation to the first Bash
 * tool_use event appearing in the `agent_events` DB table for a dispatched process.
 *
 * Runs N consecutive dispatches (default 5) and records timing/isolation metrics.
 *
 * Usage:
 *   npx tsx scripts/measure-dispatch-first-event.ts \
 *     --agent <name> \
 *     --goal <path> \
 *     [--runs <n>]
 *
 * Output:
 *   workspace/final/measurement-results.json
 *
 * Exit codes:
 *   0 — all runs passed all criteria
 *   1 — one or more runs failed
 */

import { spawnSync, spawn } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'
// Use relative path — @skill-networks/database is not in root node_modules (pnpm workspace)
import { getSqlClient, closeSqlClient } from '../packages/database/src/client.js'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { agent: string; goal: string; runs: number } {
  const args = process.argv.slice(2)

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag)
    return idx !== -1 ? args[idx + 1] : undefined
  }

  const agent = getArg('--agent')
  const goal = getArg('--goal')
  const runsStr = getArg('--runs')

  if (!agent || !goal) {
    console.error(
      'Usage: npx tsx scripts/measure-dispatch-first-event.ts --agent <name> --goal <path> [--runs <n>]',
    )
    process.exit(1)
  }

  const runs = runsStr ? parseInt(runsStr, 10) : 5
  if (isNaN(runs) || runs <= 0) {
    console.error(`ERROR: --runs must be a positive integer, got: ${runsStr}`)
    process.exit(1)
  }

  return { agent, goal, runs }
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await fn()
    if (result !== null) return result
    await sleep(intervalMs)
  }
  return null
}

// ---------------------------------------------------------------------------
// Non-gameability check
// ---------------------------------------------------------------------------

function runNonGameabilityCheck(): 'PASS' | 'FAIL' {
  const filesToCheck = [
    path.join(process.cwd(), 'utils', 'loop', 'index.ts'),
    path.join(process.cwd(), 'utils', 'dispatch', 'dispatch.ts'),
  ]
  const pattern = 'first-event|first_event|measurement_marker|timing_banner'

  for (const file of filesToCheck) {
    if (!fs.existsSync(file)) continue
    const result = spawnSync('grep', ['-E', pattern, file], { encoding: 'utf-8' })
    if (result.status === 0 && result.stdout.trim().length > 0) {
      console.error(`Non-gameability check FAIL: synthetic marker found in ${file}`)
      console.error(result.stdout.trim())
      return 'FAIL'
    }
  }
  return 'PASS'
}

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------

function checkAuth(): boolean {
  const result = spawnSync('npx', ['duoidal', 'auth', 'whoami'], {
    stdio: 'pipe',
    encoding: 'utf-8',
  })
  return result.status === 0
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

function runDispatch(agent: string, goalPath: string): Promise<{ skillResourceId: string | null; error: string | null }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const child = spawn('npx', ['duoidal', 'execute', '--agent', agent, goalPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('close', (code) => {
      // Parse "Skill resource ID: <uuid>" from stdout
      const match = stdout.match(/Skill resource ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      if (match) {
        resolve({ skillResourceId: match[1], error: null })
      } else {
        const errMsg = `duoidal execute failed (exit ${code}). stdout: ${stdout.slice(0, 500)} stderr: ${stderr.slice(0, 500)}`
        resolve({ skillResourceId: null, error: errMsg })
      }
    })

    child.on('error', (err) => {
      resolve({ skillResourceId: null, error: `spawn error: ${err.message}` })
    })
  })
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

interface ProcessRow {
  id: string
  worktree_path: string | null
  status: string
}

async function findProcessBySkillResourceId(skillResourceId: string): Promise<ProcessRow | null> {
  try {
    const sql = getSqlClient()
    const rows = await sql<ProcessRow[]>`
      SELECT id, worktree_path, status
      FROM processes
      WHERE skill_resource_id = ${skillResourceId}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `
    return rows.length > 0 ? rows[0] : null
  } catch {
    return null
  }
}

interface AgentEventRow {
  id: string
  ts: Date
}

async function findFirstBashEvent(processId: string): Promise<AgentEventRow | null> {
  try {
    const sql = getSqlClient()
    const rows = await sql<AgentEventRow[]>`
      SELECT id, ts
      FROM agent_events
      WHERE process_id = ${processId}::uuid
        AND source = 'bash'
      ORDER BY ts ASC
      LIMIT 1
    `
    return rows.length > 0 ? rows[0] : null
  } catch {
    return null
  }
}

async function waitForProcessComplete(processId: string): Promise<boolean> {
  const result = await pollUntil(
    async () => {
      try {
        const sql = getSqlClient()
        const rows = await sql<{ id: string }[]>`
          SELECT id
          FROM processes
          WHERE id = ${processId}::uuid
            AND status = 'completed'
          LIMIT 1
        `
        return rows.length > 0 ? true : null
      } catch {
        return null
      }
    },
    120_000, // 120s timeout for COMPLETE
    500,
  )
  return result === true
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface RunResult {
  run: number
  t0: string
  t1: string | null
  delta: number | null
  process_id: string | null
  worktree_path: string | null
  hops: number | null
  completed: boolean
  error: string | null
}

interface Summary {
  all_under_10s: boolean
  max_delta_ms: number | null
  runs_with_process_row: number
  runs_with_agent_event: number
  runs_completed: number
  non_gameability_check: 'PASS' | 'FAIL'
  worktree_isolation_check: 'PASS' | 'FAIL'
}

interface MeasurementResults {
  timestamp: string
  agent: string
  goal: string
  runs: RunResult[]
  summary: Summary
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function ensureOutputDir(outputPath: string): void {
  const dir = path.dirname(outputPath)
  fs.mkdirSync(dir, { recursive: true })
}

function writeResults(outputPath: string, results: MeasurementResults): void {
  ensureOutputDir(outputPath)
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2) + '\n', 'utf-8')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { agent, goal, runs } = parseArgs()
  const callerCwd = process.cwd()
  const outputPath = path.join(callerCwd, 'workspace', 'final', 'measurement-results.json')

  console.log(`[measure] agent=${agent} goal=${goal} runs=${runs}`)
  console.log(`[measure] output → ${outputPath}`)

  // Non-gameability check — done once upfront
  const nonGameabilityCheck = runNonGameabilityCheck()
  console.log(`[measure] non-gameability check: ${nonGameabilityCheck}`)

  // Initialize result structure (written even on early failure)
  const timestamp = new Date().toISOString()
  const runResults: RunResult[] = []

  const partialResults = (): MeasurementResults => {
    const withProcess = runResults.filter((r) => r.process_id !== null).length
    const withEvent = runResults.filter((r) => r.t1 !== null).length
    const completed = runResults.filter((r) => r.completed).length
    const deltas = runResults.map((r) => r.delta).filter((d): d is number => d !== null)
    const maxDelta = deltas.length > 0 ? Math.max(...deltas) : null

    const isolationOk = runResults
      .filter((r) => r.worktree_path !== null)
      .every(
        (r) =>
          r.worktree_path!.startsWith('/root/dispatch/') &&
          !r.worktree_path!.startsWith(callerCwd) &&
          r.worktree_path !== callerCwd,
      )

    return {
      timestamp,
      agent,
      goal,
      runs: runResults,
      summary: {
        all_under_10s: deltas.length === runs && deltas.every((d) => d < 10_000),
        max_delta_ms: maxDelta,
        runs_with_process_row: withProcess,
        runs_with_agent_event: withEvent,
        runs_completed: completed,
        non_gameability_check: nonGameabilityCheck,
        worktree_isolation_check: runResults.filter((r) => r.worktree_path !== null).length > 0
          ? isolationOk ? 'PASS' : 'FAIL'
          : 'FAIL',
      },
    }
  }

  // Auth check
  const authOk = checkAuth()
  if (!authOk) {
    console.error('[measure] Auth check failed — duoidal auth whoami returned non-zero')
    for (let i = 1; i <= runs; i++) {
      runResults.push({
        run: i,
        t0: new Date().toISOString(),
        t1: null,
        delta: null,
        process_id: null,
        worktree_path: null,
        hops: null,
        completed: false,
        error: 'auth_failed',
      })
    }
    writeResults(outputPath, partialResults())
    process.exit(1)
  }

  console.log('[measure] Auth OK')

  // Run N dispatches
  for (let i = 1; i <= runs; i++) {
    console.log(`\n[measure] === Run ${i}/${runs} ===`)

    const runResult: RunResult = {
      run: i,
      t0: new Date().toISOString(),
      t1: null,
      delta: null,
      process_id: null,
      worktree_path: null,
      hops: null,
      completed: false,
      error: null,
    }

    try {
      // t0: wall-clock moment of dispatch invocation
      const t0Wall = Date.now()
      runResult.t0 = new Date(t0Wall).toISOString()

      console.log(`[measure] Dispatching: duoidal execute --agent ${agent} ${goal}`)
      const { skillResourceId, error: dispatchError } = await runDispatch(agent, goal)

      if (!skillResourceId) {
        runResult.error = dispatchError ?? 'dispatch failed: no skill resource ID'
        console.error(`[measure] Run ${i} dispatch error: ${runResult.error}`)
        runResults.push(runResult)
        continue
      }

      console.log(`[measure] skill_resource_id=${skillResourceId}`)

      // Poll for process row (up to 30s)
      console.log('[measure] Waiting for process row...')
      const processRow = await pollUntil(
        () => findProcessBySkillResourceId(skillResourceId),
        30_000,
        500,
      )

      if (!processRow) {
        runResult.error = `timeout: process row not found within 30s for skill_resource_id=${skillResourceId}`
        console.error(`[measure] Run ${i}: ${runResult.error}`)
        runResults.push(runResult)
        continue
      }

      runResult.process_id = processRow.id
      runResult.worktree_path = processRow.worktree_path

      // Infer hops: if worktree_path doesn't start with caller's cwd, hops >= 1
      if (processRow.worktree_path) {
        runResult.hops = processRow.worktree_path.startsWith(callerCwd) ? 0 : 1
      }

      console.log(`[measure] process_id=${processRow.id} worktree=${processRow.worktree_path} hops=${runResult.hops}`)

      // Poll for first bash event (up to 60s)
      console.log('[measure] Waiting for first bash agent_event...')
      const firstEvent = await pollUntil(
        () => findFirstBashEvent(processRow.id),
        60_000,
        500,
      )

      if (!firstEvent) {
        runResult.error = `timeout: first bash event not found within 60s for process_id=${processRow.id}`
        console.error(`[measure] Run ${i}: ${runResult.error}`)
        runResults.push(runResult)
        continue
      }

      runResult.t1 = firstEvent.ts instanceof Date ? firstEvent.ts.toISOString() : String(firstEvent.ts)
      runResult.delta = new Date(runResult.t1).getTime() - t0Wall
      console.log(`[measure] First bash event at t1=${runResult.t1} delta=${runResult.delta}ms`)

      // Poll for COMPLETE (up to 120s)
      console.log('[measure] Waiting for process completion...')
      const completed = await waitForProcessComplete(processRow.id)
      runResult.completed = completed
      console.log(`[measure] completed=${completed}`)
    } catch (err) {
      runResult.error = err instanceof Error ? err.message : String(err)
      console.error(`[measure] Run ${i} unexpected error: ${runResult.error}`)
    }

    runResults.push(runResult)
  }

  // Build final results and write
  const finalResults = partialResults()
  writeResults(outputPath, finalResults)
  console.log(`\n[measure] Results written to ${outputPath}`)
  console.log('[measure] Summary:', JSON.stringify(finalResults.summary, null, 2))

  // Determine exit code: 0 if all runs passed all criteria
  const allPassed =
    runResults.length === runs &&
    runResults.every(
      (r) =>
        r.error === null &&
        r.process_id !== null &&
        r.t1 !== null &&
        r.delta !== null &&
        r.delta < 10_000 &&
        r.worktree_path !== null &&
        r.worktree_path.startsWith('/root/dispatch/') &&
        !r.worktree_path.startsWith(callerCwd) &&
        r.completed,
    ) &&
    finalResults.summary.non_gameability_check === 'PASS'

  await closeSqlClient()
  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error('[measure] Unhandled error:', err)
  process.exit(1)
})
