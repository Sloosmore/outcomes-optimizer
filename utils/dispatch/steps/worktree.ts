/**
 * Git worktree management for dispatch workflows.
 *
 * Provides create and destroy operations for git worktrees.
 */

import { execFileSync } from 'child_process'
import * as path from 'path'
import { fileURLToPath } from 'url'

/**
 * Creates a git worktree at the specified path.
 * Defaults to <repoRoot>/.claude/worktrees/<slug> if no worktreePath given.
 * Returns the worktree path.
 */
export function createWorktree(opts: {
  slug: string
  repoRoot: string
  branch: string
  worktreePath?: string
}): string {
  const worktreePath =
    opts.worktreePath ?? path.join(opts.repoRoot, '.claude', 'worktrees', opts.slug)
  execFileSync('git', ['worktree', 'add', worktreePath, opts.branch], {
    cwd: opts.repoRoot,
    stdio: 'inherit',
  })
  return worktreePath
}

/**
 * Destroys a git worktree.
 * Defaults to <repoRoot>/.claude/worktrees/<slug> if no worktreePath given.
 */
export function destroyWorktree(opts: {
  slug: string
  repoRoot: string
  worktreePath?: string
}): void {
  const worktreePath =
    opts.worktreePath ?? path.join(opts.repoRoot, '.claude', 'worktrees', opts.slug)
  execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: opts.repoRoot,
    stdio: 'inherit',
  })
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help')) {
    console.log(`Usage: worktree.ts <subcommand> [options]

Subcommands:
  create  --slug <slug> --repo <repo-root> --branch <branch> [--path <worktree-path>]
            Creates git worktree at path (default: <repo-root>/.claude/worktrees/<slug>)
            Prints the worktree path

  destroy --slug <slug> --repo <repo-root> [--path <worktree-path>]
            Removes git worktree at path (default: <repo-root>/.claude/worktrees/<slug>)`)
    process.exit(0)
  }

  const subcommand = args[0]
  const rest = args.slice(1)

  const parsed: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = rest[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        parsed[key] = value
        i++
      }
    }
  }

  if (subcommand === 'create') {
    if (!parsed['slug'] || !parsed['repo'] || !parsed['branch']) {
      console.error('Error: --slug, --repo, and --branch are required for create')
      process.exit(1)
    }
    const result = createWorktree({
      slug: parsed['slug'],
      repoRoot: parsed['repo'],
      branch: parsed['branch'],
      worktreePath: parsed['path'],
    })
    console.log(result)
  } else if (subcommand === 'destroy') {
    if (!parsed['slug'] || !parsed['repo']) {
      console.error('Error: --slug and --repo are required for destroy')
      process.exit(1)
    }
    destroyWorktree({
      slug: parsed['slug'],
      repoRoot: parsed['repo'],
      worktreePath: parsed['path'],
    })
  } else {
    console.error(`Unknown subcommand: ${subcommand}`)
    process.exit(1)
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
