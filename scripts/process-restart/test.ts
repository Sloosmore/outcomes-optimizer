#!/usr/bin/env npx tsx
/**
 * Integration test for process-restart utility.
 *
 * Creates a real test process, runs the restart util against it with --no-relaunch,
 * then verifies the original is failed and the new process is pending. Cleans up.
 *
 * Run with:
 *   DOPPLER_PROJECT=<your-project> DOPPLER_CONFIG=<your-config> doppler run -- npx tsx scripts/process-restart/test.ts
 */
import { execFileSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_BRANCH = 'test/restart-util'

function agentCore(...args: string[]): string {
  const cliParts = (process.env['SKILL_NETWORKS_CLI'] ?? 'pnpm exec duoidal').split(' ')
  return execFileSync(cliParts[0], [...cliParts.slice(1), 'process', ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function processStatus(id: string): { status: string; branch?: string } {
  const json = agentCore('status', '--id', id, '--json')
  return JSON.parse(json)
}

function runRestartUtil(id: string, reason: string): void {
  execFileSync(
    'npx', ['tsx', resolve(__dirname, 'index.ts'), '--id', id, '--reason', reason, '--no-relaunch'],
    { stdio: 'inherit', encoding: 'utf-8' }
  )
}

let originalId = ''
let newId = ''
let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS: ${message}`)
    passed++
  } else {
    console.error(`  FAIL: ${message}`)
    failed++
  }
}

async function main() {
  console.log('=== process-restart integration test ===\n')

  // Step 1: Create a real test process (unique name per run to avoid conflicts)
  const testName = `test-restart-util-${Date.now()}`
  console.log(`Step 1: Creating test process for branch ${TEST_BRANCH} (name: ${testName})`)
  const initOutput = agentCore('init', '--branch', TEST_BRANCH, '--name', testName)
  originalId = initOutput.split('\n').filter(Boolean).pop()!.trim()
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(originalId),
    `process init returned a valid UUID: ${originalId}`
  )
  console.log(`  Original process ID: ${originalId}\n`)

  // Step 2: Run the restart util with --no-relaunch and capture new ID from stdout
  console.log('Step 2: Running restart util (--no-relaunch)...')
  // Capture stdout to extract new ID
  const output = execFileSync(
    'npx', ['tsx', resolve(__dirname, 'index.ts'), '--id', originalId, '--reason', 'integration-test', '--no-relaunch'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] }
  )
  const newIdMatch = output.match(/New process ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  assert(newIdMatch !== null, 'restart util printed a new process ID')
  newId = newIdMatch?.[1] ?? ''
  console.log(`  New process ID: ${newId}\n`)

  // Step 3: Verify original process is now 'failed'
  console.log('Step 3: Verifying original process is failed...')
  const origStatus = processStatus(originalId)
  assert(origStatus.status === 'failed', `original process status is 'failed' (got: ${origStatus.status})`)
  console.log()

  // Step 4: Verify new process is 'pending'
  console.log('Step 4: Verifying new process is pending...')
  if (newId) {
    const newStatus = processStatus(newId)
    assert(newStatus.status === 'pending', `new process status is 'pending' (got: ${newStatus.status})`)
    assert(newStatus.branch === TEST_BRANCH, `new process has correct branch (got: ${newStatus.branch})`)
  } else {
    assert(false, 'no new process ID to verify')
  }
  console.log()

  // Step 5: Cleanup — fail the new process too
  console.log('Step 5: Cleaning up...')
  if (newId) {
    agentCore('fail', '--id', newId, '--reason', 'integration-test-cleanup')
    const cleanStatus = processStatus(newId)
    assert(cleanStatus.status === 'failed', `new process cleaned up (status: ${cleanStatus.status})`)
  }
  console.log()

  // Summary
  console.log(`=== Results: ${passed} passed, ${failed} failed ===`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Test error:', err.message)
  process.exit(1)
})
