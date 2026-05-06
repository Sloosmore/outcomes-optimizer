/**
 * E2E sleep test loop - 3 sleep/wake cycles per child process.
 * Placed in utils/loop/ so process resume validation passes.
 * Called via: npx tsx utils/loop/e2e-child-loop.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { execFileSync } from 'child_process'
import path from 'path'
import { getCliCommand } from '../cli-prefix.js'

const WORKTREE = process.env.WORKTREE_PATH ?? process.cwd()
const COUNT_FILE = path.join(WORKTREE, 'workspace', 'sleep_count.txt')
const STATE_FILE = path.join(WORKTREE, 'workspace', 'state.json')
const PROGRESS_FILE = path.join(WORKTREE, 'workspace', 'progress.md')
const SLEEPING_FLAG = path.join(WORKTREE, 'workspace', '.sleeping')

mkdirSync(path.join(WORKTREE, 'workspace'), { recursive: true })

let count = 0
if (existsSync(COUNT_FILE)) {
  const raw = readFileSync(COUNT_FILE, 'utf-8').trim()
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed)) {
    console.error(`[e2e-child] Corrupted COUNT_FILE contents: ${JSON.stringify(raw)}`)
    process.exit(1)
  }
  count = parsed
}

const pid = process.env.EVAL_PROCESS_ID ?? 'unknown'
console.log(`[e2e-child] Process: ${pid} | sleep_count=${count}`)

if (count < 3) {
  const newCount = count + 1
  writeFileSync(COUNT_FILE, String(newCount))

  // Write epoch to state.json (required by process sleep to set resume_context.epoch)
  writeFileSync(STATE_FILE, JSON.stringify({ epoch: newCount, status: 'in_progress' }))

  console.log(`[e2e-child] Sleeping (rep ${newCount}/3)...`)

  // Create .sleeping BEFORE calling process sleep
  // This signals to the launch.ts wrapper to preserve the worktree
  writeFileSync(SLEEPING_FLAG, '')

  try {
    const [bin, prefixArgs] = getCliCommand()
    execFileSync(bin, [...prefixArgs, 'process', 'sleep', '--interval', '1 minute'], {
      stdio: 'inherit',
      cwd: WORKTREE,
      timeout: 30000,
    })
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string | null }
    console.error('[e2e-child] ERROR calling process sleep:', err.message)
    if (err.stderr) console.error('stderr:', err.stderr.toString())
    process.exit(1)
  }

  console.log('[e2e-child] Sleep command completed (process now in waiting state)')
  process.exit(0)
} else {
  console.log('[e2e-child] All 3 sleep reps done!')
  appendFileSync(PROGRESS_FILE, 'COMPLETE\n')
  process.exit(0)
}
