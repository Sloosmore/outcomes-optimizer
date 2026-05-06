#!/usr/bin/env npx tsx
/**
 * E2E verification script for openPRAdapter.
 *
 * Verifies the full open-pr flow against real GitHub:
 *   1. Launches a child loop in a worktree with --pr, polls until a PR appears
 *   2. Creates a parent PR via openPRAdapter directly
 *   3. Asserts both PRs exist, diff is clean, auto-merge is enabled
 *
 * Run: npx tsx utils/loop/adapters/__tests__/open-pr.e2e.ts
 *
 * NOT a vitest test — the .e2e.ts suffix excludes it from `npm test`.
 */

import { execSync, execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '../../../..')
const POLL_INTERVAL_MS = 15_000
const MAX_WAIT_MS = 15 * 60_000
const timestamp = Math.floor(Date.now() / 1000)

async function main() {
  // Step 1: Preflight hard gate
  try {
    execSync('gh auth status', { stdio: 'pipe' })
  } catch {
    console.error('FAIL: gh auth status failed')
    process.exit(1)
  }

  const remoteUrl = execSync('git remote get-url origin', { cwd: REPO_ROOT }).toString().trim()
  if (!remoteUrl.includes('github.com')) {
    console.error('FAIL: git remote is not github.com')
    process.exit(1)
  }
  console.log('Preflight passed')

  // Extract owner/repo from remote URL
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  if (!match) {
    console.error('Cannot parse owner/repo from remote URL')
    process.exit(1)
  }
  const [, owner, repo] = match

  // Step 2: Generate child branch name
  const childBranch = `verify-outcome-policy-${timestamp}`

  // Verify branch doesn't exist on GitHub
  try {
    execSync(`gh api repos/${owner}/${repo}/branches/${childBranch}`, { stdio: 'pipe' })
    console.error(`FAIL: child branch ${childBranch} already exists`)
    process.exit(1)
  } catch {
    // Expected 404
  }
  console.log(`Child branch ${childBranch} confirmed fresh`)

  // Step 3: Create git worktree for child
  const worktreePath = join(REPO_ROOT, '.claude', 'worktrees', `e2e-${timestamp}`)
  execSync(`git worktree add --detach "${worktreePath}"`, { cwd: REPO_ROOT })
  execSync(`git -C "${worktreePath}" checkout -b "${childBranch}"`)

  // Step 4: Set up workspace in worktree
  const wsDir = join(worktreePath, 'workspace')
  mkdirSync(wsDir, { recursive: true })

  // Clean any pre-existing progress.md (may be tracked in git on this branch)
  const existingProgress = join(wsDir, 'progress.md')
  if (existsSync(existingProgress)) {
    rmSync(existingProgress)
  }

  writeFileSync(
    join(wsDir, 'goal.md'),
    `# Goal: E2E Test Marker

Add a single-line code comment \`// e2e-verification-marker-${timestamp}\` as the LAST line of \`utils/loop/adapters/open-pr.ts\`.

After making the change, write \`**COMPLETE**\` as the first line of \`workspace/progress.md\`.

Do not make any other changes to any other files outside workspace/.
`,
  )

  writeFileSync(
    join(wsDir, 'state.json'),
    JSON.stringify({ epoch: 0, child_branch: childBranch, status: 'pending' }),
  )

  // Step 5: Build and launch tmux session for child
  const sessionName = `e2e-child-${timestamp}`
  const processId = randomUUID()

  // Shell-escape values that may contain special characters
  function shellEscape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  const envExports: string[] = []
  if (process.env.ANTHROPIC_API_KEY) {
    envExports.push(`export ANTHROPIC_API_KEY=${shellEscape(process.env.ANTHROPIC_API_KEY)}`)
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    envExports.push(`export ANTHROPIC_BASE_URL=${shellEscape(process.env.ANTHROPIC_BASE_URL)}`)
  }

  const logFile = join(worktreePath, 'run-loop.log')
  const script = [
    `cd ${shellEscape(worktreePath)}`,
    `export PATH=${shellEscape(worktreePath + '/node_modules/.bin')}:$PATH`,
    `export EVAL_PROCESS_ID=${shellEscape(processId)}`,
    `export EVAL_BRANCH=${shellEscape(childBranch)}`,
    ...envExports,
    `set -o pipefail`,
    `npx tsx utils/loop/index.ts --goal-file workspace/goal.md --max-epochs 1 --pr 2>&1 | tee run-loop.log`,
  ].join('\n')

  execFileSync('tmux', ['new-session', '-d', '-s', sessionName, 'bash', '-c', script])
  console.log(`Child loop launched: tmux attach -t ${sessionName}`)

  // Step 6: Poll for child PR
  let childPrNumber: number | undefined
  let childPrState: string | undefined
  const startTime = Date.now()

  while (Date.now() - startTime < MAX_WAIT_MS) {
    try {
      const result = execSync(
        `gh pr list --state all --head ${childBranch} --json number,state`,
        { cwd: REPO_ROOT, stdio: 'pipe' },
      )
        .toString()
        .trim()

      const prs = JSON.parse(result)
      if (prs.length > 0) {
        childPrNumber = prs[0].number
        childPrState = prs[0].state
        break
      }
    } catch (err) {
      console.warn(`Poll error: ${(err as Error).message}`)
    }

    // Check if tmux session still exists
    try {
      execSync(`tmux has-session -t ${sessionName}`, { stdio: 'pipe' })
    } catch {
      // Session ended but no PR found yet - check log for errors
      if (existsSync(logFile)) {
        const log = readFileSync(logFile, 'utf-8')
        console.log(`Child session ended. Log tail:\n${log.split('\n').slice(-30).join('\n')}`)
      } else {
        console.log('Child session ended. No log file found.')
      }
      // Grace period poll
      await sleep(5000)
      try {
        const result = execSync(
          `gh pr list --state all --head ${childBranch} --json number,state`,
          { cwd: REPO_ROOT, stdio: 'pipe' },
        )
          .toString()
          .trim()
        const prs = JSON.parse(result)
        if (prs.length > 0) {
          childPrNumber = prs[0].number
          childPrState = prs[0].state
        }
      } catch (gracePollErr) {
        console.warn(`Grace poll error: ${(gracePollErr as Error).message}`)
      }
      break
    }

    console.log(`Polling... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`)
    await sleep(POLL_INTERVAL_MS)
  }

  // Step 7: Assert criteria
  const results: { criterion: string; pass: boolean; evidence: string }[] = []

  // Criterion 1: Child PR confirmed on GitHub
  if (childPrNumber && (childPrState === 'OPEN' || childPrState === 'MERGED')) {
    results.push({
      criterion: 'Child PR confirmed',
      pass: true,
      evidence: `PR #${childPrNumber} state=${childPrState}`,
    })
  } else {
    results.push({
      criterion: 'Child PR confirmed',
      pass: false,
      evidence: `No PR found or state=${childPrState}`,
    })
  }

  if (childPrNumber) {
    // Criterion 2: Child PR diff clean (no workspace/)
    const diff = execSync(`gh pr diff ${childPrNumber}`, { cwd: REPO_ROOT, stdio: 'pipe' }).toString()
    const workspaceDiffLines = diff.split('\n').filter((l) => l.startsWith('diff --git a/workspace/'))
    results.push({
      criterion: 'Child PR diff clean',
      pass: workspaceDiffLines.length === 0,
      evidence: `workspace diff lines: ${workspaceDiffLines.length}`,
    })

    // Criterion 3: Child code change visible
    const codeDiffLines = diff
      .split('\n')
      .filter((l) => l.startsWith('diff --git a/') && !l.startsWith('diff --git a/workspace/'))
    results.push({
      criterion: 'Child code change visible',
      pass: codeDiffLines.length > 0,
      evidence: `non-workspace diff lines: ${codeDiffLines.length}`,
    })

    // Criterion 4: Auto-merge enabled
    const autoMergeJson = execSync(`gh pr view ${childPrNumber} --json autoMergeRequest`, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    }).toString()
    const autoMerge = JSON.parse(autoMergeJson)
    results.push({
      criterion: 'Auto-merge enabled',
      pass: autoMerge.autoMergeRequest !== null,
      evidence: `autoMergeRequest: ${JSON.stringify(autoMerge.autoMergeRequest)}`,
    })
  }

  // Criterion 5: Parent PR (using a separate worktree to avoid branch switching on REPO_ROOT)
  const parentBranch = `verify-outcome-parent-${timestamp}`
  const parentWorktreePath = join(REPO_ROOT, '.claude', 'worktrees', `e2e-parent-${timestamp}`)
  try {
    execSync(`git worktree add --detach "${parentWorktreePath}"`, { cwd: REPO_ROOT })
    execSync(`git -C "${parentWorktreePath}" checkout -b "${parentBranch}"`)

    // Make a small change in the parent worktree (don't push — let openPRAdapter handle it)
    const markerFile = join(parentWorktreePath, `.e2e-parent-marker-${timestamp}`)
    writeFileSync(markerFile, `Parent e2e marker ${timestamp}\n`)
    execSync(`git -C "${parentWorktreePath}" add "${markerFile}"`, { stdio: 'pipe' })
    execSync(`git -C "${parentWorktreePath}" commit -m "e2e parent marker"`, { stdio: 'pipe' })

    // Call openPRAdapter (it handles push + PR creation + auto-merge)
    // Use absolute path with file:// URL for dynamic import under tsx
    const openPrPath = join(REPO_ROOT, 'utils', 'loop', 'adapters', 'open-pr.ts')
    const { openPRAdapter } = await import(openPrPath)
    openPRAdapter({ branch: parentBranch, worktreePath: parentWorktreePath })

    // Verify parent PR
    await sleep(3000)
    const parentResult = execSync(
      `gh pr list --state all --head ${parentBranch} --json number,state`,
      { cwd: REPO_ROOT, stdio: 'pipe' },
    )
      .toString()
      .trim()
    const parentPrs = JSON.parse(parentResult)
    results.push({
      criterion: 'Parent PR confirmed',
      pass: parentPrs.length > 0 && (parentPrs[0].state === 'OPEN' || parentPrs[0].state === 'MERGED'),
      evidence:
        parentPrs.length > 0 ? `PR #${parentPrs[0].number} state=${parentPrs[0].state}` : 'No PR found',
    })
  } catch (err) {
    results.push({ criterion: 'Parent PR confirmed', pass: false, evidence: `Error: ${err}` })
  }

  // Print results
  console.log('\n=== E2E Verification Results ===')
  let allPass = true
  for (const r of results) {
    const icon = r.pass ? 'PASS' : 'FAIL'
    console.log(`[${icon}] ${r.criterion}: ${r.evidence}`)
    if (!r.pass) allPass = false
  }

  // Cleanup
  console.log('\nCleaning up...')
  try {
    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'pipe' })
  } catch {
    // Session may already be gone
  }

  // Close child PR if open
  if (childPrNumber) {
    try {
      execSync(`gh pr close ${childPrNumber}`, { cwd: REPO_ROOT, stdio: 'pipe' })
    } catch (err) {
      console.warn(`Could not close child PR: ${(err as Error).message}`)
    }
  }

  // Close parent PR if open
  try {
    const parentPrResult = execSync(
      `gh pr list --state open --head ${parentBranch} --json number`,
      { cwd: REPO_ROOT, stdio: 'pipe' },
    )
      .toString()
      .trim()
    const parentOpenPrs = JSON.parse(parentPrResult)
    for (const p of parentOpenPrs) {
      execSync(`gh pr close ${p.number}`, { cwd: REPO_ROOT, stdio: 'pipe' })
    }
  } catch (err) {
    console.warn(`Could not close parent PR: ${(err as Error).message}`)
  }

  // Remove worktrees
  try {
    execSync(`git -C "${REPO_ROOT}" worktree remove --force "${worktreePath}"`, { stdio: 'pipe' })
  } catch (err) {
    console.warn(`Could not remove child worktree: ${(err as Error).message}`)
  }
  try {
    rmSync(worktreePath, { recursive: true, force: true })
  } catch {
    // Already removed
  }

  try {
    execSync(`git -C "${REPO_ROOT}" worktree remove --force "${parentWorktreePath}"`, { stdio: 'pipe' })
  } catch (err) {
    console.warn(`Could not remove parent worktree: ${(err as Error).message}`)
  }
  try {
    rmSync(parentWorktreePath, { recursive: true, force: true })
  } catch {
    // Already removed
  }

  // Delete remote branches
  try {
    execSync(`git push origin --delete "${childBranch}"`, { cwd: REPO_ROOT, stdio: 'pipe' })
  } catch (err) {
    console.warn(`Could not delete remote child branch: ${(err as Error).message}`)
  }
  try {
    execSync(`git push origin --delete "${parentBranch}"`, { cwd: REPO_ROOT, stdio: 'pipe' })
  } catch (err) {
    console.warn(`Could not delete remote parent branch: ${(err as Error).message}`)
  }

  // Clean up local branches
  try {
    execSync(`git -C "${REPO_ROOT}" branch -D "${parentBranch}"`, { stdio: 'pipe' })
  } catch (err) {
    console.warn(`Could not delete local parent branch: ${(err as Error).message}`)
  }

  // Save results to /tmp to avoid polluting the repo workspace
  const resultsDir = join(tmpdir(), 'open-pr-e2e-results')
  mkdirSync(resultsDir, { recursive: true })
  const resultsPath = join(resultsDir, `e2e-results-${timestamp}.json`)
  writeFileSync(resultsPath, JSON.stringify({ timestamp, results, allPass }, null, 2))

  if (!allPass) {
    console.log('\nFAILED: Not all criteria passed')
    process.exit(1)
  }

  console.log('\nPASSED: All criteria verified')
  process.exit(0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
