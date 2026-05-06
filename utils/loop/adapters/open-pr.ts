/**
 * Open PR adapter for the loop — strips workspace artifacts, pushes the branch,
 * and creates a PR against main. Does NOT enable auto-merge — the PR waits for
 * human approval and all CI to pass before merging.
 */

import { execFileSync as defaultExecFileSync } from 'child_process'
import { isAbsolute } from 'path'
import { SAFE_BRANCH_RE } from '../../types.js'

type ExecFileSyncFn = typeof defaultExecFileSync

export interface OpenPROpts {
  branch: string
  worktreePath: string
  title?: string
  body?: string
}

/**
 * Strips workspace/ from the git index, commits, pushes, and creates a PR.
 * Accepts an optional exec parameter for dependency injection (defaults to execFileSync).
 */
export function stripAndPush(opts: OpenPROpts, exec: ExecFileSyncFn = defaultExecFileSync): void {
  const { branch, worktreePath, title, body } = opts
  const cwd = worktreePath
  const execOpts = { cwd, stdio: 'inherit' as const }

  // Strip workspace/ from git index (ignore errors if not tracked)
  try {
    exec('git', ['rm', '-r', '--cached', 'workspace/'], execOpts)
  } catch (err) {
    console.warn(`stripAndPush: git rm skipped (workspace not tracked): ${(err as Error).message}`)
  }

  // Commit the strip (ignore errors if nothing to commit)
  try {
    exec('git', ['commit', '-m', 'chore: strip workspace before PR'], execOpts)
  } catch (err) {
    console.warn(`stripAndPush: commit skipped (nothing to commit): ${(err as Error).message}`)
  }

  // Push branch with force-with-lease (safer than --force)
  exec('git', ['push', '--force-with-lease', 'origin', branch], execOpts)

  // Create PR against main
  const prTitle = title ?? `chore: ${branch}`
  const prBody = body ?? ''
  exec(
    'gh',
    ['pr', 'create', '--draft', '--base', 'main', '--head', branch, '--title', prTitle, '--body', prBody],
    execOpts,
  )
}

/**
 * Main entry point used by executeLoop. Validates opts, logs progress, and calls stripAndPush.
 */
export function openPRAdapter(opts: OpenPROpts): void {
  if (!opts.branch) {
    throw new Error('openPRAdapter: branch is required but was empty or not set')
  }
  if (!SAFE_BRANCH_RE.test(opts.branch)) {
    throw new Error(`openPRAdapter: branch contains unsafe characters: ${opts.branch}`)
  }
  if (!opts.worktreePath) {
    throw new Error('openPRAdapter: worktreePath is required but was empty or not set')
  }
  if (!isAbsolute(opts.worktreePath)) {
    throw new Error(`openPRAdapter: worktreePath must be an absolute path: ${opts.worktreePath}`)
  }

  console.log(`Opening PR for branch: ${opts.branch}`)
  console.log(`Worktree: ${opts.worktreePath}`)
  if (opts.title) console.log(`Title: ${opts.title}`)

  stripAndPush(opts)

  console.log(`PR opened for branch: ${opts.branch} — waiting for CI and human approval`)
}
