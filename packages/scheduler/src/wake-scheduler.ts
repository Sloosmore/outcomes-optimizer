/**
 * Wake Scheduler — standalone script that wakes sleeping processes.
 *
 * Queries the database for processes WHERE status='waiting' AND resume_at <= NOW(),
 * then calls `npx agent-core process resume --id <id>` for each one.
 *
 * Also runs two orphan detection jobs:
 * - Job 1 (compose cleanup): finds active processes with no events in last N time,
 *   runs compose teardown only, leaves process status unchanged.
 * - Job 2 (worktree cleanup): finds active processes with no events in last N time
 *   (longer threshold), marks failed in DB, runs full teardown.
 *
 * Usage: npx tsx packages/scheduler/src/wake-scheduler.ts
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { ProcessesService } from '@skill-networks/database'
import { getSqlClient, closeSqlClient } from '@skill-networks/database/client'

const execFileAsync = promisify(execFile)
const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[wake-scheduler] ${msg}`, ...(meta ? [meta] : [])),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[wake-scheduler] ${msg}`, ...(meta ? [meta] : [])),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(`[wake-scheduler] ${msg}`, ...(meta ? [meta] : [])),
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_INTERVAL = /^(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)$/i
const SAFE_SLUG = /^[a-zA-Z0-9_-]+$/
// Allow only alphanumerics, spaces, dots, slashes, underscores, hyphens — no shell metacharacters.
// execFileAsync (not exec/shell) is used, so this is a correctness guard, not an injection guard.
const SAFE_CLI = /^[a-zA-Z0-9 ./_-]+$/

function validateInterval(value: string, name: string): string {
  if (!SAFE_INTERVAL.test(value)) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(value)} — must match "<number> <unit>" (e.g. "1 hour", "30 minutes")`)
  }
  return value
}

/** Convert a validated interval string like "2 hours" to milliseconds. */
function intervalToMs(value: string): number {
  const match = SAFE_INTERVAL.exec(value)!
  const amount = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const multipliers: Record<string, number> = {
    second: 1_000, seconds: 1_000,
    minute: 60_000, minutes: 60_000,
    hour: 3_600_000, hours: 3_600_000,
    day: 86_400_000, days: 86_400_000,
  }
  const ms = multipliers[unit]
  if (ms === undefined) throw new Error(`Unreachable: unit "${unit}" not in multipliers map`)
  return amount * ms
}

function validateRow(row: { id: string; resume_context: string | null }): string | null {
  if (!UUID_RE.test(row.id)) return `invalid id format: ${row.id}`
  if (row.resume_context === null) return 'resume_context is null'
  return null
}

async function main(): Promise<void> {
  const processesService = new ProcessesService(getSqlClient())

  // ── Step 1: Query for processes ready to wake ─────────────────────
  log.info('Querying for processes with status=waiting and resume_at <= NOW()...')

  const rows = await processesService.findWaitingProcesses()

  if (rows.length === 0) {
    log.info('No processes to wake')
  } else {
    log.info(`Found ${rows.length} process(es) to wake`)

    // ── Wake each process ───────────────────────────────────────────
    let woken = 0
    let failed = 0

    for (const row of rows) {
      try {
        log.info(`Waking process ${row.id}...`)

        // ── Step 2: Validate row fields before any work ──────────────
        const validationError = validateRow(row)
        if (validationError) {
          log.warn(`Skipping process ${row.id}: ${validationError}`)
          await processesService.fail(row.id, validationError)
          failed++
          continue
        }

        // ── Step 3: Parse resume_context for logging ─────────────────
        let ctx: { worktree_path?: string; loop_cmd?: string; epoch?: number } = {}
        try {
          ctx = JSON.parse(row.resume_context!) as typeof ctx
        } catch {
          log.warn(`Process ${row.id} has unparseable resume_context — marking failed`)
          await processesService.fail(row.id, 'unparseable resume_context')
          failed++
          continue
        }

        if (!ctx.worktree_path || !ctx.loop_cmd) {
          log.error(`Process ${row.id} has invalid resume_context (missing worktree_path or loop_cmd) — marking failed`)
          await processesService.fail(row.id, 'invalid resume_context: missing worktree_path or loop_cmd')
          failed++
          continue
        }

        // ── Step 4: Call process resume directly ─────────────────────
        const rawCli = process.env['SKILL_NETWORKS_CLI'] ?? 'pnpm exec duoidal'
        if (!SAFE_CLI.test(rawCli)) {
          throw new Error(`Invalid SKILL_NETWORKS_CLI value: ${JSON.stringify(rawCli)}`)
        }
        const cliParts = rawCli.trim().split(/\s+/)
        await execFileAsync(
          cliParts[0],
          [...cliParts.slice(1), 'process', 'resume', '--id', row.id],
          { cwd: process.env.SKILL_NETWORKS_REPO, timeout: 30_000 },
        )

        log.info(`Resumed process ${row.id}`)
        woken++
      } catch (err) {
        log.error(`Error waking process ${row.id}`, { error: err as Error })
        try {
          await processesService.fail(row.id, `wake error: ${(err as Error).message}`)
        } catch (dbErr) {
          log.error(`Could not mark process ${row.id} as failed`, { error: dbErr as Error })
        }
        failed++
      }
    }

    log.info(`Done: ${woken} woken, ${failed} failed out of ${rows.length} total`)
  }

  // ── Job 1: Orphan compose cleanup ────────────────────────────────
  const composeThreshold = validateInterval(process.env.ORPHAN_COMPOSE_THRESHOLD ?? '1 hour', 'ORPHAN_COMPOSE_THRESHOLD')
  log.info(`Checking for compose orphans (threshold: ${composeThreshold})...`)

  // Bind a concrete cutoff timestamp — avoids sql.unsafe for interval interpolation.
  const composeCutoff = new Date(Date.now() - intervalToMs(composeThreshold))
  const composeOrphans = await processesService.findOrphanProcesses(composeCutoff)

  if (composeOrphans.length === 0) {
    log.info('No compose orphans found')
  } else {
    log.info(`Found ${composeOrphans.length} compose orphan(s)`)
    const repoRoot = process.env.SKILL_NETWORKS_REPO
    if (!repoRoot) {
      log.warn('SKILL_NETWORKS_REPO not set — skipping compose orphan teardown')
    } else {
      const teardownScript = path.join(repoRoot, 'utils/dispatch/teardown.ts')
      for (const orphan of composeOrphans) {
        if (!orphan.worktree_path) {
          log.warn(`Orphan ${orphan.id} (${orphan.name}) has no worktree_path — skipping compose teardown`)
          continue
        }
        if (!path.isAbsolute(orphan.worktree_path) || orphan.worktree_path.includes('..') || orphan.worktree_path.includes('\0')) {
          log.warn(`Orphan ${orphan.id} has unsafe worktree_path — skipping compose teardown`)
          continue
        }
        if (!SAFE_SLUG.test(orphan.name)) {
          log.warn(`Orphan ${orphan.id} has unsafe name ${JSON.stringify(orphan.name)} — skipping compose teardown`)
          continue
        }
        log.info(`Running compose teardown for orphan ${orphan.id} (${orphan.name}) at ${orphan.worktree_path}`)
        try {
          await execFileAsync(
            'npx',
            ['tsx', teardownScript, '--slug', orphan.name, '--worktree', orphan.worktree_path, '--provision', 'compose'],
            { timeout: 120_000 },
          )
          log.info(`Compose teardown complete for orphan ${orphan.id}`)
        } catch (err) {
          log.error(`Compose teardown failed for orphan ${orphan.id}`, { error: err as Error })
        }
        // NOTE: Process status intentionally NOT changed for compose-only orphans
      }
    } // end repoRoot check
  }

  // ── Job 2: Orphan worktree cleanup ───────────────────────────────
  const worktreeThreshold = validateInterval(process.env.ORPHAN_WORKTREE_THRESHOLD ?? '2 hours', 'ORPHAN_WORKTREE_THRESHOLD')
  log.info(`Checking for worktree orphans (threshold: ${worktreeThreshold})...`)

  // Bind a concrete cutoff timestamp — avoids sql.unsafe for interval interpolation.
  const worktreeCutoff = new Date(Date.now() - intervalToMs(worktreeThreshold))
  const worktreeOrphans = await processesService.findOrphanProcesses(worktreeCutoff)

  if (worktreeOrphans.length === 0) {
    log.info('No worktree orphans found')
  } else {
    log.info(`Found ${worktreeOrphans.length} worktree orphan(s)`)
    const repoRootWorktree = process.env.SKILL_NETWORKS_REPO
    if (!repoRootWorktree) {
      // Without the teardown script we cannot clean up the worktree or compose services.
      // Skip DB status mutation to avoid marking processes failed without cleaning up —
      // they will be re-evaluated on the next poll once SKILL_NETWORKS_REPO is set.
      log.warn('SKILL_NETWORKS_REPO not set — skipping worktree orphan cleanup entirely (will retry next poll)')
    } else {
      const teardownScript = path.join(repoRootWorktree, 'utils/dispatch/teardown.ts')
      for (const orphan of worktreeOrphans) {
        // Step 1: Mark process as failed in DB
        try {
          await processesService.fail(orphan.id, 'orphan worktree cleanup')
          log.info(`Marked orphan ${orphan.id} (${orphan.name}) as failed`)
        } catch (dbErr) {
          log.error(`Could not mark orphan ${orphan.id} as failed`, { error: dbErr as Error })
          continue
        }

        if (!orphan.worktree_path) {
          log.warn(`Orphan ${orphan.id} (${orphan.name}) has no worktree_path — skipping full teardown`)
          continue
        }

        if (!path.isAbsolute(orphan.worktree_path) || orphan.worktree_path.includes('..') || orphan.worktree_path.includes('\0')) {
          log.warn(`Orphan ${orphan.id} has unsafe worktree_path — skipping full teardown`)
          continue
        }

        if (!SAFE_SLUG.test(orphan.name)) {
          log.warn(`Orphan ${orphan.id} has unsafe name ${JSON.stringify(orphan.name)} — skipping full teardown`)
          continue
        }

        // Step 2: Run full teardown (compose + worktree)
        log.info(`Running full teardown for worktree orphan ${orphan.id} (${orphan.name}) at ${orphan.worktree_path}`)
        try {
          await execFileAsync(
            'npx',
            ['tsx', teardownScript, '--slug', orphan.name, '--worktree', orphan.worktree_path, '--provision', 'compose', '--provision', 'worktree'],
            { timeout: 120_000 },
          )
          log.info(`Full teardown complete for orphan ${orphan.id}`)
        } catch (err) {
          log.error(`Full teardown failed for orphan ${orphan.id}`, { error: err as Error })
        }
      }
    } // end repoRootWorktree check
  }
}

// ── Daemon mode ──────────────────────────────────────────────────────────────

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/wake-scheduler.ts') || process.argv[1].endsWith('/wake-scheduler'))

if (isMain) {
  const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

  if (!process.env.SKILL_NETWORKS_DATABASE_URL && !process.env.DATABASE_URL) {
    log.error('Fatal: missing required env var: SKILL_NETWORKS_DATABASE_URL or DATABASE_URL')
    process.exit(1)
  }

  if (!process.env.SKILL_NETWORKS_REPO) {
    log.error('SKILL_NETWORKS_REPO not set')
    process.exit(1)
  }

  log.info('Started (interval: 5m)')

  process.on('SIGTERM', () => {
    closeSqlClient().then(() => process.exit(0)).catch(() => process.exit(1))
  })

  // Sequential loop: wait for main() to finish before scheduling the next poll,
  // preventing overlapping poll cycles when many processes need waking.
  async function loop(): Promise<void> {
    await main().catch(e => log.error(`Poll error: ${(e as Error).message}`))
    setTimeout(loop, POLL_INTERVAL_MS)
  }

  loop()
}
