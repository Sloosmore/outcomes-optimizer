/**
 * E2E no-sleep test loop - completes immediately without sleeping.
 * Used to verify worktree teardown happens after a clean exit (no sleep).
 * Placed in utils/loop/ so process resume validation passes.
 * Called via: npx tsx utils/loop/e2e-nosleep-loop.ts
 */
import { appendFileSync, mkdirSync } from 'fs'
import path from 'path'

const WORKTREE = process.env.WORKTREE_PATH ?? process.cwd()
mkdirSync(path.join(WORKTREE, 'workspace'), { recursive: true })
const PROGRESS = path.join(WORKTREE, 'workspace', 'progress.md')

console.log(`[e2e-nosleep] Process: ${process.env.EVAL_PROCESS_ID ?? 'unknown'} completing normally (no sleep)`)
appendFileSync(PROGRESS, 'COMPLETE\n')
process.exit(0)
