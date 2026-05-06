/**
 * Conservative auto-prune for stale dispatch artifacts.
 *
 * Re-dispatching the same --skill-resource-id leaves three kinds of cruft
 * behind from prior failed/abandoned runs that block a new dispatch:
 *   1. git branch `boot/<slug>` still tied to a worktree
 *   2. filesystem directory `<DISPATCH_BASE_DIR>/<slug>`
 *   3. processes row with `name = <slug>` (init_process RPC returns 409)
 *
 * This module detects whether the prior run is STILL RUNNING (via tmux probe)
 * and aborts with a clear error if so, to avoid clobbering live work. If no
 * active tmux session is found, it auto-prunes the three artifacts above for
 * the specific slug only.
 *
 * All failures in the prune itself are non-fatal — we log a WARNING and let
 * the caller proceed so the real init_process error surfaces naturally if
 * something is still wedged.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getUnscopedAdapter } from './adapter-factory.js'
import { getSqlClient } from '@skill-networks/database/client'
import { createLogger } from '@skill-networks/logger'
import type { DispatchConfig } from './dispatch-config.js'

const logger = createLogger('agent-core:dispatch-prune')

// Stale statuses we're willing to clean up. Anything else (`active`, `running`,
// `waiting`, `blocked`, `sleeping`) is a live state the user must resolve.
const STALE_STATUSES = ['failed', 'completed', 'pending'] as const

/** Hard timeout for any remote ssh probe. */
const SSH_PROBE_TIMEOUT_MS = 10_000

export interface PruneTarget {
  slug: string
  worktreeRepo: string
  dispatchBaseDir: string
  skillResourceId: string
  config: DispatchConfig
}

/**
 * Safety-check + auto-prune entry point.
 *
 * @param target - paths + slug for the dispatch being re-issued
 * @param opts.force - when true, bypass the tmux active-session check and prune anyway
 * @throws if an active tmux session is detected and --force is not set
 */
export async function pruneStaleDispatchArtifacts(
  target: PruneTarget,
  opts: { force?: boolean } = {},
): Promise<void> {
  const { slug, config } = target
  const sessionName = `dispatch-${slug}`

  // --- Safety check ---------------------------------------------------------
  if (!opts.force) {
    const active = probeTmuxSession(sessionName, config)
    if (active.exists) {
      throw new Error(
        `Refusing to re-dispatch skill ${target.skillResourceId}: active tmux session '${sessionName}' found on ${active.targetDescription}.\n` +
          `If you're sure the prior run is dead, kill the session first:\n` +
          `  ${active.killCommand}\n` +
          `OR dispatch with --force to prune regardless, OR dispatch with --fresh to use a timestamped slug.`,
      )
    }
  }

  // --- Prune (each step is best-effort; failures logged but non-fatal) -----
  pruneBranchAndWorktree(target)
  pruneBaseDir(target)
  await prunePendingProcessRow(target)
}

// ---------------------------------------------------------------------------
// Tmux probe
// ---------------------------------------------------------------------------

interface TmuxProbeResult {
  exists: boolean
  targetDescription: string
  killCommand: string
}

function probeTmuxSession(sessionName: string, config: DispatchConfig): TmuxProbeResult {
  if (config.server === 'self') {
    const res = spawnSync('tmux', ['has-session', '-t', sessionName], {
      encoding: 'utf8',
      timeout: SSH_PROBE_TIMEOUT_MS,
    })
    return {
      exists: res.status === 0,
      targetDescription: 'local host',
      killCommand: `tmux kill-session -t ${sessionName}`,
    }
  }

  const serverName = config.server
  const serverConfig = config.servers?.[serverName]
  if (!serverConfig) {
    // No server config — can't probe, so treat as unknown (not active) and let
    // the real routing surface the config error.
    logger.warn(`dispatch-prune: no config for server '${serverName}'; skipping tmux probe`)
    return {
      exists: false,
      targetDescription: serverName,
      killCommand: `# (no server config)`,
    }
  }

  const { host, user, key, container } = serverConfig
  const remoteInner = container
    ? `docker exec ${container} tmux has-session -t ${sessionName}`
    : `tmux has-session -t ${sessionName}`

  const res = spawnSync(
    'ssh',
    [
      '-i', key,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=5',
      '--', `${user}@${host}`, remoteInner,
    ],
    { encoding: 'utf8', timeout: SSH_PROBE_TIMEOUT_MS },
  )

  const targetDescription = container ? `${serverName} (${container})` : serverName
  const killCommand = container
    ? `ssh ${user}@${host} 'docker exec ${container} tmux kill-session -t ${sessionName}'`
    : `ssh ${user}@${host} 'tmux kill-session -t ${sessionName}'`

  // ssh tmux has-session: exit 0 means session exists. Non-zero means either
  // no session, timeout, or connection failure. We only treat exit 0 as "active"
  // to stay conservative — a transient ssh error should not block dispatch.
  return {
    exists: res.status === 0,
    targetDescription,
    killCommand,
  }
}

// ---------------------------------------------------------------------------
// Prune steps
// ---------------------------------------------------------------------------

function pruneBranchAndWorktree(target: PruneTarget): void {
  const { slug, worktreeRepo, dispatchBaseDir, config } = target
  const worktreePath = path.join(dispatchBaseDir, slug)
  const branchName = `boot/${slug}`

  if (config.server !== 'self') {
    pruneBranchAndWorktreeRemote(target, worktreePath, branchName)
    return
  }

  // Only attempt git operations if the source repo looks like a git repo.
  // On a fresh checkout the repo always has a .git; we only skip if the path
  // is missing entirely (e.g. misconfigured WORKTREE_REPO).
  if (!fs.existsSync(worktreeRepo)) {
    logger.warn(`dispatch-prune: worktree repo ${worktreeRepo} does not exist; skipping git cleanup`)
    return
  }

  runLoggedBestEffort('git', ['-C', worktreeRepo, 'worktree', 'remove', '--force', worktreePath], 'worktree remove')
  runLoggedBestEffort('git', ['-C', worktreeRepo, 'worktree', 'prune'], 'worktree prune')
  runLoggedBestEffort('git', ['-C', worktreeRepo, 'branch', '-D', branchName], 'branch -D')
}

function pruneBranchAndWorktreeRemote(target: PruneTarget, worktreePath: string, branchName: string): void {
  const { config } = target
  const serverName = config.server
  const serverConfig = config.servers?.[serverName]
  if (!serverConfig) return

  const { host, user, key, container, worktree_repo } = serverConfig
  const remoteRepo = worktree_repo ?? '/root/repos/outcomes-optimizer'

  const gitCmds = [
    `git -C ${remoteRepo} worktree remove --force ${worktreePath} 2>/dev/null || true`,
    `git -C ${remoteRepo} worktree prune 2>/dev/null || true`,
    `git -C ${remoteRepo} branch -D ${branchName} 2>/dev/null || true`,
    `rm -rf ${worktreePath} 2>/dev/null || true`,
  ].join('; ')

  const inner = container ? `docker exec ${container} sh -c ${shellQuote(gitCmds)}` : gitCmds

  const res = spawnSync(
    'ssh',
    [
      '-i', key,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=5',
      '--', `${user}@${host}`, inner,
    ],
    { encoding: 'utf8', timeout: SSH_PROBE_TIMEOUT_MS },
  )

  if (res.status !== 0) {
    logger.warn(
      `dispatch-prune: remote cleanup returned non-zero on ${serverName}; detail=${(res.stderr || res.stdout || '').trim().slice(0, 200)}`,
    )
  }
}

function pruneBaseDir(target: PruneTarget): void {
  const { slug, dispatchBaseDir, config } = target
  if (config.server !== 'self') return
  const worktreePath = path.join(dispatchBaseDir, slug)
  if (!fs.existsSync(worktreePath)) return
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true })
  } catch (err) {
    logger.warn(`dispatch-prune: rm -rf ${worktreePath} failed: ${(err as Error).message ?? String(err)}`)
  }
}

async function prunePendingProcessRow(target: PruneTarget): Promise<void> {
  const { slug, skillResourceId } = target
  try {
    const adapter = getUnscopedAdapter()
    const existing = await adapter.getProcessByName(slug)
    if (!existing) return

    // Belt-and-braces defensive check: if the status is live (active/running/
    // waiting/blocked/sleeping), we refuse to delete even if the tmux probe
    // above reported no session. This is the split-brain case — log a WARNING
    // and let the caller decide.
    if (!(STALE_STATUSES as readonly string[]).includes(existing.status)) {
      logger.warn(
        `dispatch-prune: process '${slug}' has non-stale status '${existing.status}' but no active tmux session detected; leaving row in place. Use 'duoidal process fail --id ${existing.id}' or '--force' to clear manually.`,
      )
      return
    }

    // Defense-in-depth: only delete rows that match BOTH the slug and the
    // skill_resource_id we were asked to re-dispatch. Never broad-delete.
    if (existing.skill_resource_id && existing.skill_resource_id !== skillResourceId) {
      logger.warn(
        `dispatch-prune: process '${slug}' belongs to a different skill_resource_id (${existing.skill_resource_id}); refusing to prune.`,
      )
      return
    }

    // Targeted single-row cleanup of stale dispatch artifacts. No service API
    // exposes this because it is a dispatch-time recovery concern, not a normal
    // CRUD operation. Constraint enforcement above: we only delete when status
    // is in the explicit STALE_STATUSES allowlist AND the id matches the row we
    // just fetched by name, so the slug+status AND clause is belt-and-braces.
    const sql = getSqlClient()
    await sql`
      DELETE FROM processes
      WHERE id = ${existing.id}
        AND name = ${slug}
        AND status = ANY(${sql.array([...STALE_STATUSES])})
    `
  } catch (err) {
    logger.warn(`dispatch-prune: process row cleanup failed: ${(err as Error).message ?? String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runLoggedBestEffort(bin: string, args: string[], label: string): void {
  const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 15_000 })
  if (res.status !== 0 && res.status !== null) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 200)
    // Non-zero exit is COMMON here ("nothing to remove", "branch not found") —
    // these git commands are idempotent cleanups, not operations that must
    // succeed. Log at debug so the happy-path re-dispatch doesn't flood stderr.
    logger.debug(`dispatch-prune: ${label} exit=${res.status} detail=${detail}`)
  }
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
