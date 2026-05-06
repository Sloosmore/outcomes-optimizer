/**
 * Pull request creation for dispatch workflows.
 *
 * Strips workspace artifacts, pushes the branch, and opens a PR.
 * Does NOT enable auto-merge — the PR waits for human approval and all CI to pass.
 */

import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

/**
 * Creates a pull request from the given branch.
 * Strips workspace/ from the git index, commits, pushes, and creates a PR.
 * Does NOT enable auto-merge — the PR waits for human approval and all CI to pass.
 */
export function createPR(opts: {
  slug: string
  branch: string
  worktreePath: string
  title?: string
  body?: string
  draft?: boolean
}): void {
  const { branch, worktreePath, title, body, draft } = opts
  const cwd = worktreePath
  const execOpts = { cwd, stdio: 'inherit' as const }

  // Strip workspace/ from git index (ignore errors if not tracked)
  try {
    execFileSync('git', ['rm', '-r', '--cached', 'workspace/'], execOpts)
  } catch (err) {
    console.warn(`createPR: git rm skipped (workspace not tracked): ${(err as Error).message}`)
  }

  // Commit the strip (ignore errors if nothing to commit)
  try {
    execFileSync('git', ['commit', '-m', 'chore: strip workspace before PR'], execOpts)
  } catch (err) {
    console.warn(`createPR: commit skipped (nothing to commit): ${(err as Error).message}`)
  }

  // Push branch
  execFileSync('git', ['push', 'origin', branch], execOpts)

  // Build gh pr create args — use execFileSync to avoid shell injection
  const prTitle = title ?? `chore: ${branch}`
  const prBody = body ?? ''
  const prCreateArgs = ['pr', 'create', '--base', 'main', '--head', branch, '--title', prTitle, '--body', prBody]
  if (draft) {
    prCreateArgs.push('--draft')
  }
  execFileSync('gh', prCreateArgs, execOpts)
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help')) {
    console.log(`Usage: pr.ts --slug <slug> --branch <branch> --worktree <path> [--title <title>] [--body <body>] [--draft]

Options:
  --slug      Unique slug identifying this dispatch run
  --branch    Git branch name to push and open PR from
  --worktree  Path to the git worktree directory
  --title     PR title (default: "chore: <branch>")
  --body      PR body text (default: empty)
  --draft     Open the PR as a draft

Steps performed:
  1. Strip workspace/ from git index
  2. Commit the strip (if anything changed)
  3. Push branch to origin
  4. Create PR against main (no auto-merge — waits for human approval and CI)`)
    process.exit(0)
  }

  const parsed: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        parsed[key] = value
        i++
      }
    }
  }

  if (!parsed['slug'] || !parsed['branch'] || !parsed['worktree']) {
    console.error('Error: --slug, --branch, and --worktree are required')
    process.exit(1)
  }

  createPR({
    slug: parsed['slug'],
    branch: parsed['branch'],
    worktreePath: parsed['worktree'],
    title: parsed['title'],
    body: parsed['body'],
    draft: args.includes('--draft'),
  })
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
