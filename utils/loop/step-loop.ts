#!/usr/bin/env tsx
/**
 * Step loop for E2E sleep/wake test.
 * Executes exactly ONE step per invocation:
 * - Checks which files exist in workspace/ to determine current step
 * - Writes the appropriate file
 * - Calls process sleep (for steps 1-3)
 * - Or marks completion (for step 4)
 */
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { getCliCommand } from '../cli-prefix.js'

const PROCESS_ID = process.env.EVAL_PROCESS_ID
const WORKTREE_PATH = process.env.WORKTREE_PATH || process.cwd()
const WORKSPACE = join(WORKTREE_PATH, 'workspace')

if (!PROCESS_ID) {
  console.error('ERROR: EVAL_PROCESS_ID not set')
  process.exit(1)
}

console.log(`step-loop: PROCESS_ID=${PROCESS_ID}, WORKSPACE=${WORKSPACE}`)

const s1 = join(WORKSPACE, 'pre-sleep-1.txt')
const s2 = join(WORKSPACE, 'pre-sleep-2.txt')
const s3 = join(WORKSPACE, 'pre-sleep-3.txt')
const done = join(WORKSPACE, 'post-sleep.txt')

function callSleep(): void {
  try {
    const [bin, prefixArgs] = getCliCommand()
    const result = execFileSync(bin, [...prefixArgs, 'process', 'sleep', '--interval', '2 minutes'], {
      encoding: 'utf-8',
      cwd: WORKTREE_PATH,
      timeout: 30000,
    })
    console.log('sleep result:', result.trim())
  } catch (e: unknown) {
    const err = e as Error & { stderr?: string }
    console.error('ERROR calling process sleep:', err.message)
    if (err.stderr) console.error('stderr:', err.stderr)
    process.exit(1)
  }
}

if (!existsSync(s1)) {
  console.log('STEP 1: Writing pre-sleep-1.txt')
  writeFileSync(s1, 'step-1-complete')
  callSleep()
  console.log('EPOCH COMPLETE')
  process.exit(0)
} else if (!existsSync(s2)) {
  console.log('STEP 2: Writing pre-sleep-2.txt')
  writeFileSync(s2, 'step-2-complete')
  callSleep()
  console.log('EPOCH COMPLETE')
  process.exit(0)
} else if (!existsSync(s3)) {
  console.log('STEP 3: Writing pre-sleep-3.txt')
  writeFileSync(s3, 'step-3-complete')
  callSleep()
  console.log('EPOCH COMPLETE')
  process.exit(0)
} else if (!existsSync(done)) {
  console.log('STEP 4: Writing post-sleep.txt (FINAL)')
  writeFileSync(done, 'all-steps-complete')
  // Mark process complete — no more sleep cycles
  try {
    const [bin, prefixArgs] = getCliCommand()
    const result = execFileSync(bin, [...prefixArgs, 'process', 'complete', '--id', PROCESS_ID!], {
      encoding: 'utf-8',
      cwd: WORKTREE_PATH,
      timeout: 30000,
    })
    console.log('process complete result:', result.trim())
  } catch (e: unknown) {
    const err = e as Error & { stderr?: string }
    console.error('Warning: could not mark process complete:', err.message)
    if (err.stderr) console.error('stderr:', err.stderr)
  }
  console.log('EPOCH COMPLETE - ALL STEPS DONE')
  process.exit(0)
} else {
  console.log('All steps already complete.')
  process.exit(0)
}
