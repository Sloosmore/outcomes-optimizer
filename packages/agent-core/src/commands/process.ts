import { Command } from 'commander'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import * as fs from 'fs'
import * as path from 'path'
import os from 'node:os'
import { getAdapter, getUnscopedAdapter } from '../lib/adapter-factory.js'
import { getLocalSubUnchecked } from '../lib/identity.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

const VALID_RUN_TYPES = ['cloud', 'local', 'moltbot'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INTERVAL_RE = /^\d+\s+(seconds?|minutes?|hours?|days?|weeks?)$/i

const PROJECT_PATH = path.join(os.homedir(), '.config', 'duoidal', 'project.json')

function readLocalProject(): { name: string; id: string } | null {
  try {
    const raw = fs.readFileSync(PROJECT_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.id === 'string' && typeof parsed?.name === 'string') {
      return { id: parsed.id, name: parsed.name }
    }
    return null
  } catch {
    return null
  }
}

function writeLocalProject(project: { name: string; id: string }): void {
  const dir = path.dirname(PROJECT_PATH)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = PROJECT_PATH + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(project, null, 2), { mode: 0o600 })
  fs.renameSync(tmpPath, PROJECT_PATH)
}

function resolveProcessId(explicit?: string): string {
  let id = explicit ?? process.env.EVAL_PROCESS_ID
  if (!id) {
    id = process.env.EVAL_CAMPAIGN_ID
    if (id && process.env.DUOIDAL_DEBUG) {
      process.stderr.write(JSON.stringify({ level: 'warn', code: 'DEPRECATED_ENV_VAR', message: 'EVAL_CAMPAIGN_ID is deprecated — use EVAL_PROCESS_ID' }) + '\n')
    }
  }
  if (!id) throw new Error('--id is required or set EVAL_PROCESS_ID environment variable')
  if (!UUID_RE.test(id)) throw new Error('--id must be a valid UUID')
  return id
}


export function processCommand(): Command {
  const cmd = new Command('process').description('Manage processes (campaigns)')

  cmd
    .command('init')
    .description('Create a new process. Prints the process ID to stdout. Re-running with the same name creates a distinct row.')
    .requiredOption('--name <name>', 'Process name')
    .option('--branch <branch>', 'Git branch name')
    .option('--run-type <type>', 'Run origin: cloud | local | moltbot')
    .option('--skill-resource-id <uuid>', 'Skill resource UUID (required unless --unlinked)')
    .option('--unlinked', 'Allow process creation without a skill resource (manual/test runs only)')
    .option('--training-set-id <uuid-or-name>', 'Training set resource UUID or name')
    .option('--channel-id <uuid>', 'Channel ID for session routing (UUID)')
    .option('--queued', 'Create process with status queued (for pollQueued dispatch)')
    .option('--prompt <prompt>', 'Prompt to run when dispatched (stored in resume_context)')
    .option('--parent-process-id <uuid>', 'Parent process UUID (sets parent_process_id)')
    .option('--worktree-path <path>', 'Worktree path on disk')
    .option('--project-id <uuid>', 'Project UUID (sets project_id)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const { id } = await initProcess(opts)
        if (opts.json) {
          // Flat injection for backward compat: existing consumers read parsed.id at top level.
          // (worktree.ts uses non-JSON mode; watchdog-e2e.integration.test.ts reads parsed.id)
          console.log(JSON.stringify({ ok: true, id }, null, 2))
        } else {
          // worktree.ts reads just the UUID from stdout — keep this unchanged
          console.log(id)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('status')
    .description('Read current process state from the database')
    .option('--name <name>', 'Process name')
    .option('--id <uuid>', 'Process UUID')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await showProcessStatus(opts)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('record')
    .description('Upload epoch results from workspace/epochs/ to the database')
    .option('--name <name>', 'Process name')
    .option('--id <uuid>', 'Process UUID')
    .option('--workspace <dir>', 'Workspace directory', './workspace')
    .option('--epoch <number>', 'Only upload this specific epoch number')
    .option('--session-id <id>', 'CLI session ID to attach to the epoch result')
    .option('--cost <number>', 'Execution cost (USD) to attach to the epoch result')
    .option('--duration-ms <number>', 'Execution duration in milliseconds to attach to the epoch result')
    .action(async (opts) => {
      try {
        await recordEpochs(opts)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('update')
    .description('Update fields on an existing process')
    .option('--id <uuid>', 'Process UUID')
    .option('--name <name>', 'Process name')
    .option('--channel-id <uuid>', 'New channel ID (UUID)')
    .option('--worktree-path <path>', 'Filesystem path to the process worktree')
    .action(async (opts) => {
      try {
        await updateProcess(opts)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('sleep')
    .description('Put a process to sleep until a future time')
    .option('--id <uuid>', 'Process UUID (overrides EVAL_PROCESS_ID)')
    .option('--minutes <n>', 'Number of minutes to sleep (alternative to --interval)')
    .option('--interval <duration>', 'Postgres interval (e.g. "30 minutes", "1 hour")')
    .option('--json', 'Output as JSON')
    .action(async (opts: { id?: string; minutes?: string; interval?: string; json?: boolean }) => {
      try {
        let interval = opts.interval
        if (!interval && opts.minutes) {
          const n = Number(opts.minutes)
          if (!Number.isFinite(n) || n <= 0) throw new Error('--minutes must be a positive number')
          interval = `${n} minutes`
        }
        if (!interval) throw new Error('--interval or --minutes is required')

        // Resolve the process ID: --id flag takes priority, then env var
        let id = opts.id
        if (!id) {
          id = process.env.EVAL_PROCESS_ID
          if (!id) {
            id = process.env.EVAL_CAMPAIGN_ID
            if (id && process.env.DUOIDAL_DEBUG) {
              process.stderr.write(JSON.stringify({ level: 'warn', code: 'DEPRECATED_ENV_VAR', message: 'EVAL_CAMPAIGN_ID is deprecated — use EVAL_PROCESS_ID' }) + '\n')
            }
          }
        }
        if (!id) throw new Error('EVAL_PROCESS_ID environment variable is required')
        if (!UUID_RE.test(id)) throw new Error('--id must be a valid UUID')

        await sleepProcess(id, interval)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('active')
    .description('Set process status to active')
    .requiredOption('--id <uuid>', 'Process UUID')
    .action(async (opts: { id: string }) => {
      try {
        if (!UUID_RE.test(opts.id)) {
          throw new Error('--id must be a valid UUID')
        }
        await getAdapter().activateProcess(opts.id)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('complete')
    .description('Set process status to completed')
    .option('--id <uuid>', 'Process UUID (defaults to EVAL_PROCESS_ID env var)')
    .action(async (opts: { id?: string }) => {
      try {
        const id = resolveProcessId(opts.id)
        await getAdapter().completeProcess(id)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('fail')
    .description('Set process status to failed')
    .option('--id <uuid>', 'Process UUID (defaults to EVAL_PROCESS_ID env var)')
    .option('--reason <string>', 'Failure reason (stored if column exists)')
    .action(async (opts: { id?: string; reason?: string }) => {
      try {
        const id = resolveProcessId(opts.id)
        await getAdapter().failProcess(id, opts.reason)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('block')
    .description('Set process status to blocked (hard blocker requiring human intervention)')
    .option('--id <uuid>', 'Process UUID (defaults to EVAL_PROCESS_ID env var)')
    .requiredOption('--reason <string>', 'Why the process is blocked (required)')
    .action(async (opts: { id?: string; reason: string }) => {
      try {
        const id = resolveProcessId(opts.id)
        const worktreePath = process.env.WORKTREE_PATH ?? null
        await getAdapter().blockProcess(id, opts.reason, worktreePath)
        console.log(`Process ${id} blocked: ${opts.reason}`)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('resume')
    .description('Resume a sleeping process')
    .option('--id <uuid>', 'Process UUID (defaults to EVAL_PROCESS_ID env var)')
    .action(async (opts: { id?: string }) => {
      try {
        const id = resolveProcessId(opts.id)
        await resumeProcess(id)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('reset')
    .description('Reset a failed process back to pending so it can be re-dispatched')
    .option('--id <uuid>', 'Process UUID (defaults to EVAL_PROCESS_ID env var)')
    .action(async (opts: { id?: string }) => {
      try {
        const id = resolveProcessId(opts.id)
        await getAdapter().resetProcess(id)
        console.log(`Process ${id} reset to pending`)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('restart')
    .description('Restart a failed or completed process by creating a linked child process')
    .requiredOption('--id <uuid>', 'UUID of the dead process to restart')
    .option('--json', 'Output as JSON')
    .action(async (opts: { id: string; json?: boolean }) => {
      try {
        const newId = await restartProcess(opts.id)
        if (opts.json) {
          console.log(JSON.stringify({ id: newId }, null, 2))
        } else {
          console.log(newId)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('amend')
    .description('Append text to the process goal and update the goal resource in DB')
    .requiredOption('--id <uuid>', 'Process UUID')
    .requiredOption('--append <text>', 'Text to append to workspace/goal.md')
    .action(async (opts: { id: string; append: string }) => {
      try {
        await amendProcess(opts.id, opts.append)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('list')
    .description('List processes from the database')
    .option('--status <status>', 'Filter by status (e.g. active, pending, waiting, completed, failed, blocked)')
    .option('--json', 'Output as JSON array')
    .action(async (opts: { status?: string; json?: boolean }) => {
      try {
        const rows = await getAdapter().listProcesses(opts.status ? { status: opts.status } : undefined)
        const items = rows.map(r => ({
          id: r.id,
          name: r.name,
          status: r.status,
          updatedAt: r.updated_at?.toISOString() ?? null,
          createdAt: r.created_at?.toISOString() ?? null,
          skillResourceId: r.skill_resource_id ?? null,
        }))
        if (opts.json) {
          console.log(JSON.stringify(items, null, 2))
          return
        }
        if (items.length === 0) {
          console.log('No processes found.')
          return
        }
        console.log(`${'ID'.padEnd(38)} ${'STATUS'.padEnd(12)} ${'NAME'}`)
        console.log('─'.repeat(80))
        for (const p of items) {
          console.log(`${p.id.padEnd(38)} ${p.status.padEnd(12)} ${p.name}`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cmd
    .command('claim')
    .description('Atomically transition a process from waiting to active (pure DB state transition)')
    .requiredOption('--id <uuid>', 'Process UUID')
    .option('--json', 'Output as JSON')
    .action(async (opts: { id: string; json?: boolean }) => {
      try {
        if (!UUID_RE.test(opts.id)) {
          throw new Error('--id must be a valid UUID')
        }
        const adapter = getAdapter()
        const claimed = await adapter.claimProcess(opts.id)
        if (!claimed) {
          // Check why
          const row = await adapter.getProcessById(opts.id)
          if (!row) throw new Error(`Process not found: ${opts.id}`)
          if (row.status !== 'waiting') {
            throw new Error(`Cannot claim process ${opts.id}: status is '${row.status}', expected 'waiting'`)
          }
          throw new Error(`Process ${opts.id} could not be claimed`)
        }
        if (opts.json) {
          console.log(JSON.stringify({ id: opts.id, status: 'active' }))
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  return cmd
}

// ── init ────────────────────────────────────────────────────────────────────────

interface InitOpts {
  name: string
  branch?: string
  runType?: string
  skillResourceId?: string
  unlinked?: boolean
  trainingSetId?: string
  channelId?: string
  queued?: boolean
  prompt?: string
  parentProcessId?: string
  worktreePath?: string
  projectId?: string
}

async function initProcess(opts: InitOpts): Promise<{ id: string }> {
  const { name, branch, runType, skillResourceId, trainingSetId } = opts
  const channelId = opts.channelId || undefined

  if (!skillResourceId && !opts.unlinked) {
    throw new Error('--skill-resource-id is required. Pass --unlinked to create a process without one (manual/test runs only).')
  }
  if (skillResourceId && !UUID_RE.test(skillResourceId)) {
    throw new Error('--skill-resource-id must be a valid UUID')
  }
  if (channelId && !UUID_RE.test(channelId)) {
    throw new Error('--channel-id must be a valid UUID')
  }
  if (opts.parentProcessId && !UUID_RE.test(opts.parentProcessId)) {
    throw new Error('--parent-process-id must be a valid UUID')
  }
  if (opts.projectId && !UUID_RE.test(opts.projectId)) {
    throw new Error('--project-id must be a valid UUID')
  }
  if (runType && !(VALID_RUN_TYPES as readonly string[]).includes(runType)) {
    throw new Error(`--run-type must be one of: ${VALID_RUN_TYPES.join(', ')}`)
  }

  const adapter = getAdapter()

  // Resolve training-set-id: accepts UUID or resource name
  let resolvedTrainingResourceId: string | null = trainingSetId ?? null
  if (trainingSetId && !UUID_RE.test(trainingSetId)) {
    resolvedTrainingResourceId = await adapter.resolveTrainingSetId(trainingSetId)
  }

  const status = opts.queued ? 'queued' : undefined

  // Resolve project_id via fallback chain when not explicitly provided
  let resolvedProjectId = opts.projectId ?? undefined

  if (!resolvedProjectId) {
    // Priority 2: local project.json file
    const localProject = readLocalProject()
    if (localProject) {
      resolvedProjectId = localProject.id
    } else {
      // Priority 3: DB lookup using JWT sub (unchecked — expired tokens still have valid sub)
      try {
        const sub = getLocalSubUnchecked()
        if (sub) {
          const project = await getUnscopedAdapter().resolveDefaultProject(sub)
          if (project) {
            resolvedProjectId = project.id
            // Cache for next time (best-effort, don't fail if write fails)
            try { writeLocalProject(project) } catch { /* ignore */ }
          }
        }
      } catch (err) {
        // Best-effort: continue with null project_id
        if (process.env.DUOIDAL_DEBUG) {
          process.stderr.write(JSON.stringify({ level: 'warn', code: 'PROJECT_ID_RESOLVE_FAILED', message: `Could not resolve project_id from DB: ${err instanceof Error ? err.message : String(err)}` }) + '\n')
        }
      }
    }
  }

  const id = await adapter.initProcess(name, { branch, runType, skillResourceId, resolvedTrainingResourceId, channelId, status, prompt: opts.prompt, parentProcessId: opts.parentProcessId, worktreePath: opts.worktreePath, projectId: resolvedProjectId })
  return { id }
}

// ── status ──────────────────────────────────────────────────────────────────────

interface StatusOpts {
  name?: string
  id?: string
  json?: boolean
}

async function showProcessStatus(opts: StatusOpts): Promise<void> {
  if (!opts.name && !opts.id) {
    throw new Error('--name or --id is required')
  }
  if (opts.id && !UUID_RE.test(opts.id)) {
    throw new Error('--id must be a valid UUID')
  }

  const adapter = getAdapter()

  const p = opts.id
    ? await adapter.getProcessById(opts.id)
    : await adapter.getProcessByName(opts.name!)

  if (!p) {
    const ref = opts.id ? `ID "${opts.id}"` : `"${opts.name}"`
    throw new Error(`Process not found: ${ref}`)
  }

  const epochs = await adapter.getProcessEpochs(p.id, 10)

  if (opts.json) {
    // Inject ok:true into existing object for backward compat.
    // loop.ts reads parsed.status, parsed.name, parsed.skillResourceId, parsed.resumeAt
    // All existing fields are preserved; ok:true is added for new callers.
    console.log(JSON.stringify({
      ok: true,
      id: p.id,
      name: p.name,
      status: p.status,
      currentEpoch: p.current_epoch ?? 0,
      updatedAt: p.updated_at?.toISOString() ?? null,
      branch: p.branch ?? null,
      trainingResourceId: p.training_resource_id ?? null,
      skillResourceId: p.skill_resource_id ?? null,
      resumeAt: p.resume_at?.toISOString() ?? null,
      worktreePath: p.worktree_path ?? null,
      resumeContext: p.resume_context ? JSON.parse(p.resume_context) : null,
      recentEpochs: epochs.map(e => ({
        epochNumber: e.epoch_number,
        status: e.status,
        completedAt: e.completed_at?.toISOString() ?? null,
      })),
    }, null, 2))
    return
  }

  console.log(`Process   : ${p.name}`)
  console.log(`ID        : ${p.id}`)
  console.log(`Status    : ${p.status}`)
  console.log(`Branch    : ${p.branch ?? 'none'}`)
  console.log(`Epoch     : ${p.current_epoch ?? 'none'}`)
  console.log(`Updated   : ${p.updated_at?.toISOString() ?? 'never'}`)
  if (p.resume_at) {
    console.log(`Resume at : ${p.resume_at.toISOString()}`)
  }

  if (epochs.length > 0) {
    console.log('\nRecent epochs:')
    for (const epoch of epochs) {
      const ts = epoch.completed_at ? ` (${epoch.completed_at.toISOString()})` : ''
      console.log(`  [${epoch.epoch_number}] ${epoch.status}${ts}`)
    }
  }
}

// ── sleep ───────────────────────────────────────────────────────────────────────

async function sleepProcess(id: string, interval: string): Promise<void> {
  if (!INTERVAL_RE.test(interval)) {
    throw new Error('--interval must be a simple duration like "30 minutes", "1 hour", "7 days"')
  }

  const adapter = getAdapter()
  const row = await adapter.getProcessById(id)
  if (!row) {
    throw new Error(`Process not found: ${id}`)
  }

  const worktreePath = row.worktree_path
  if (!worktreePath) {
    throw new Error(`Process ${id} has no worktree_path in the database`)
  }

  let rawLoopCmd = process.env.LOOP_CMD || 'npx tsx utils/loop/index.ts --goal-file workspace/goal.md'
  // Strip shell single-quote escaping that launch.ts adds via shellEscape().
  // e.g. "npx tsx '/abs/path/utils/loop/step-loop.ts'" → "npx tsx /abs/path/utils/loop/step-loop.ts"
  rawLoopCmd = rawLoopCmd.replace(/'([^']*)'/g, '$1')
  // Detect runner prefix BEFORE path normalisation. Without this, a
  // `node utils/loop/index.prebuilt.mjs` LOOP_CMD was being re-prefixed with
  // `npx tsx` on every resume, silently undoing the tsx-cold-start savings
  // pre-built bundles exist to deliver.
  const runner = /^node(\s|$)/.test(rawLoopCmd) ? 'node' : 'npx tsx'
  // Normalize: if rawLoopCmd contains an absolute path to utils/loop/..., extract relative portion
  // e.g., "<runner> /root/.../utils/loop/step-loop.ts" → "<runner> utils/loop/step-loop.ts"
  const loopMatch = rawLoopCmd.match(/(utils\/loop\/\S+(?:\s.*)?)$/)
  const loopCmd = loopMatch ? `${runner} ${loopMatch[1]}` : rawLoopCmd

  // Reject loop commands containing shell metacharacters — they will be split
  // on whitespace and passed as a direct argv array (no sh -c), so semicolons,
  // pipes, etc. would be passed as literal arguments, not executed.
  // Catching them here keeps resume_context clean and the error surfaced early.
  if (/[;&|`$(){}!<>]/.test(loopCmd)) {
    throw new Error(`LOOP_CMD contains disallowed shell characters: ${loopCmd}`)
  }

  // Read epoch from workspace/state.json in the worktree
  let epoch = 0
  try {
    const stateFile = path.join(worktreePath, 'workspace', 'state.json')
    const raw = fs.readFileSync(stateFile, 'utf-8')
    const state = JSON.parse(raw) as { epoch?: number }
    if (typeof state.epoch === 'number') {
      epoch = state.epoch
    }
  } catch {
    // state.json missing or unparseable — default epoch 0
  }

  const buildLocal = process.env['PROVISION_OPTS_BUILD_LOCAL'] === 'true'

  const resumeContext = JSON.stringify({
    worktree_path: worktreePath,
    loop_cmd: loopCmd,
    epoch,
    provision_opts: buildLocal ? { build_local: true } : {},
    written_at: new Date().toISOString(),
  })

  const result = await adapter.sleepProcess(id, interval, resumeContext)
  console.log(`sleeping until ${result.resume_at.toISOString()}`)
}

// ── update ──────────────────────────────────────────────────────────────────────

interface UpdateOpts {
  id?: string
  name?: string
  channelId?: string
  worktreePath?: string
}

async function updateProcess(opts: UpdateOpts): Promise<void> {
  if (!opts.id && !opts.name) {
    throw new Error('--id or --name is required')
  }
  if (opts.channelId === undefined && opts.worktreePath === undefined) {
    throw new Error('No update options provided. Use --channel-id <uuid> or --worktree-path <path>')
  }
  if (opts.id && !UUID_RE.test(opts.id)) {
    throw new Error('--id must be a valid UUID')
  }
  if (opts.channelId && !UUID_RE.test(opts.channelId)) {
    throw new Error('--channel-id must be a valid UUID')
  }
  if (opts.worktreePath !== undefined) {
    if (!path.isAbsolute(opts.worktreePath)) {
      throw new Error('--worktree-path must be an absolute path')
    }
    if (opts.worktreePath.includes('\0')) {
      throw new Error('--worktree-path contains invalid characters')
    }
  }

  const updatedId = await getAdapter().updateProcessFields({
    id: opts.id,
    name: opts.name,
    channelId: opts.channelId,
    worktreePath: opts.worktreePath,
  })

  console.log(`Updated: ${updatedId}`)
}

// ── record ──────────────────────────────────────────────────────────────────────

interface RecordOpts {
  name?: string
  id?: string
  workspace: string
  epoch?: string
  sessionId?: string
  cost?: string
  durationMs?: string
}

interface EpochFile {
  metrics?: Record<string, unknown>
  [key: string]: unknown
}

function enrichEpochData(
  data: EpochFile,
  stateSnapshot: Record<string, unknown> | null,
  cliSessionId: string | null,
  cliCost: number | null,
  cliDurationMs: number | null,
): Record<string, unknown> {
  const enriched: Record<string, unknown> = { ...data, state_snapshot: stateSnapshot }
  if (cliSessionId !== null) enriched.session_id = cliSessionId
  if (cliCost !== null) enriched.cost = cliCost
  if (cliDurationMs !== null) enriched.duration_ms = cliDurationMs
  return enriched
}

async function recordEpochs(opts: RecordOpts): Promise<void> {
  if (!opts.name && !opts.id) {
    throw new Error('--name or --id is required')
  }
  if (opts.id && !UUID_RE.test(opts.id)) {
    throw new Error('--id must be a valid UUID')
  }

  const adapter = getAdapter()

  // Resolve process ID
  let processId: string
  if (opts.id) {
    const proc = await adapter.getProcessById(opts.id)
    if (!proc) throw new Error(`Process not found: ID "${opts.id}"`)
    processId = proc.id
  } else {
    const proc = await adapter.getProcessByName(opts.name!)
    if (!proc) throw new Error(`Process not found: name "${opts.name}"`)
    processId = proc.id
  }

  // Find epoch directories
  const epochsRoot = path.join(opts.workspace, 'epochs')
  let entries: string[]
  try {
    entries = fs.readdirSync(epochsRoot)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No epochs/ directory found in workspace.')
      return
    }
    throw err
  }

  const epochFilter = opts.epoch !== undefined ? parseInt(opts.epoch, 10) : null
  if (epochFilter !== null && (isNaN(epochFilter) || epochFilter < 0)) {
    throw new Error('--epoch must be a non-negative integer')
  }

  // Parse optional CLI-supplied execution metadata
  const cliSessionId = opts.sessionId ?? null
  const cliCost = opts.cost !== undefined ? parseFloat(opts.cost) : null
  const cliDurationMs = opts.durationMs !== undefined ? parseFloat(opts.durationMs) : null
  if (cliCost !== null && (!Number.isFinite(cliCost) || cliCost < 0)) {
    throw new Error('--cost must be a non-negative finite number')
  }
  if (cliDurationMs !== null && (!Number.isFinite(cliDurationMs) || cliDurationMs < 0)) {
    throw new Error('--duration-ms must be a non-negative finite number')
  }

  // Read state.json once for all epochs
  let stateSnapshot: Record<string, unknown> | null = null
  try {
    const statePath = path.join(opts.workspace, 'state.json')
    const raw = fs.readFileSync(statePath, 'utf-8')
    stateSnapshot = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // state.json absent or unparseable — null is acceptable
  }

  const uploaded: number[] = []
  const backfilled: number[] = []

  for (const entry of entries.sort()) {
    const n = parseInt(entry, 10)
    if (isNaN(n) || n < 0 || String(n) !== entry) continue
    if (epochFilter !== null && n !== epochFilter) continue

    const epochDir = path.join(epochsRoot, entry)

    // Primary epoch file
    const primaryPath = path.join(epochDir, 'epoch.json')
    if (fs.existsSync(primaryPath)) {
      const data = readEpochFile(primaryPath)
      if (data) {
        const enrichedData = enrichEpochData(data, stateSnapshot, cliSessionId, cliCost, cliDurationMs)
        try {
          await adapter.upsertEpochResult(processId, n, enrichedData)
          console.log(`  Upserted: process=${processId} epoch=${n}`)
          uploaded.push(n)
        } catch (err) {
          if (process.env.DUOIDAL_DEBUG) {
            process.stderr.write(JSON.stringify({ level: 'warn', code: 'EPOCH_UPSERT_FAILED', message: `Could not upsert epoch ${n}: ${(err as Error).message}` }) + '\n')
          }
        }
      }
    }

    // Backfill file
    const backfillPath = path.join(epochDir, 'epoch-backfill.json')
    if (fs.existsSync(backfillPath)) {
      const data = readEpochFile(backfillPath)
      if (data) {
        const enrichedData = enrichEpochData(data, stateSnapshot, cliSessionId, cliCost, cliDurationMs)
        try {
          await adapter.upsertEpochResult(processId, n, enrichedData)
          console.log(`  Upserted: process=${processId} epoch=${n}`)
          backfilled.push(n)
        } catch (err) {
          if (process.env.DUOIDAL_DEBUG) {
            process.stderr.write(JSON.stringify({ level: 'warn', code: 'EPOCH_UPSERT_FAILED', message: `Could not upsert epoch ${n} (backfill): ${(err as Error).message}` }) + '\n')
          }
        }
      }
    }
  }

  const allEpochs = [...uploaded, ...backfilled]
  if (allEpochs.length > 0) {
    await adapter.updateProcessAggregate(processId, allEpochs)
    console.log(`  Updated process: currentEpoch=${Math.max(...allEpochs)}`)
  }

  console.log(`Done. Primary: [${uploaded.join(', ')}] Backfill: [${backfilled.join(', ')}]`)
}

function readEpochFile(filePath: string): EpochFile | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as EpochFile
  } catch (err) {
    if (process.env.DUOIDAL_DEBUG) {
      process.stderr.write(JSON.stringify({ level: 'warn', code: 'EPOCH_FILE_READ_FAILED', message: `Could not read/parse ${filePath}: ${(err as Error).message}` }) + '\n')
    }
    return null
  }
}

// ── resume ──────────────────────────────────────────────────────────────────────

async function resumeProcess(id: string): Promise<void> {
  const adapter = getAdapter()

  // Step B — read resume_context from DB
  const row = await adapter.getProcessById(id)
  if (!row) {
    throw new Error(`Process not found: ${id}`)
  }
  if (row.status !== 'waiting') {
    console.log('not waiting')
    return
  }

  let ctx: { worktree_path?: string; loop_cmd?: string; epoch?: number }
  try {
    ctx = row.resume_context ? JSON.parse(row.resume_context) : {}
  } catch (parseErr) {
    await adapter.failProcess(id, `resume_context contains invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
    process.exitCode = 1
    return
  }

  if (!ctx.worktree_path || !ctx.loop_cmd) {
    await adapter.failProcess(id, 'resume_context missing worktree_path or loop_cmd')
    process.exitCode = 1
    return
  }

  // Validate loop_cmd matches expected pattern (prevents execution of arbitrary commands).
  // Accept both runners: `npx tsx utils/loop/...` for source dispatch and
  // `node utils/loop/...prebuilt.mjs` for the bundled hot-path. Anything else
  // is rejected as an attempt to inject an unexpected command.
  if (
    !ctx.loop_cmd.startsWith('npx tsx utils/loop/') &&
    !ctx.loop_cmd.startsWith('node utils/loop/')
  ) {
    await adapter.failProcess(id, `resume_context loop_cmd has unexpected format: ${ctx.loop_cmd}`)
    process.exitCode = 1
    return
  }

  // Validate worktree_path is an absolute path with no traversal sequences
  if (!path.isAbsolute(ctx.worktree_path) || ctx.worktree_path.includes('..') || ctx.worktree_path.includes('\0')) {
    await adapter.failProcess(id, `resume_context worktree_path is invalid: ${ctx.worktree_path}`)
    process.exitCode = 1
    return
  }

  // Step C — validate worktree exists
  if (!fs.existsSync(ctx.worktree_path)) {
    await adapter.failProcess(id, `worktree not found: ${ctx.worktree_path}`)
    process.exitCode = 1
    return
  }

  // Step D — atomic DB claim
  const claimed = await adapter.claimProcess(id)
  if (!claimed) {
    console.log('already claimed')
    return
  }

  // Step E — write wake_notes
  const stateFile = path.join(ctx.worktree_path, 'workspace', 'state.json')
  let state: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8')
    state = JSON.parse(raw)
  } catch {
    // state.json missing or unparseable — start fresh
  }

  if (!Array.isArray(state.wake_notes)) {
    state.wake_notes = []
  }
  ;(state.wake_notes as unknown[]).push({
    resumed_at: new Date().toISOString(),
    epoch: ctx.epoch,
  })

  const workspaceDir = path.join(ctx.worktree_path, 'workspace')
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true })
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))

  // Step E2 — Re-provision compose services (non-fatal; agent can self-heal via duoidal compose up)
  {
    const repoRoot = process.env.SKILL_NETWORKS_REPO
      ?? (() => {
        try {
          // git worktree list --porcelain: first 'worktree' line is the main repo path
          const listOutput = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            encoding: 'utf-8', cwd: ctx.worktree_path, stdio: 'pipe',
          })
          const firstLine = listOutput.split('\n').find(l => l.startsWith('worktree '))
          if (firstLine) return firstLine.slice('worktree '.length).trim()
        } catch (e) {
          logger.warn(`[resume] Could not determine repo root via git worktree list: ${e instanceof Error ? e.message : String(e)}`)
        }
        // Last resort: derive from file location (works when running tsx from source)
        return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
      })()
    const provisionTs = path.join(repoRoot, 'utils', 'dispatch', 'provision.ts')
    if (fs.existsSync(provisionTs)) {
      const provisionCtx = ctx as { provision_opts?: { build_local?: boolean } }
      const slug = path.basename(ctx.worktree_path)
      const provisionArgs: string[] = [
        'tsx', provisionTs,
        '--slug', slug,
        '--worktree', ctx.worktree_path,
        '--provision', 'worktree',
        '--provision', 'compose',
      ]
      if (provisionCtx.provision_opts?.build_local) {
        provisionArgs.push('--build-local')
      }
      try {
        execFileSync('npx', provisionArgs, { cwd: repoRoot, stdio: 'pipe', timeout: 120_000 })
        console.log('[resume] compose re-provisioned')
      } catch (err) {
        const stderr = (err as NodeJS.ErrnoException & { stderr?: Buffer })?.stderr?.toString()
        logger.warn(`[resume] WARNING: compose re-provision failed (non-fatal): ${err instanceof Error ? err.message : String(err)}${stderr ? `\n${stderr}` : ''}`)
      }
    }
  }

  // Step E3 — Restore DB snapshot if present (non-fatal)
  {
    const snapshotPath = path.join(ctx.worktree_path, 'workspace', 'db-snapshot.sql')
    if (fs.existsSync(snapshotPath)) {
      const composeProjectFile = path.join(ctx.worktree_path, '.duoidal', 'compose-project')
      const rawProjectName = fs.existsSync(composeProjectFile)
        ? fs.readFileSync(composeProjectFile, 'utf-8').trim()
        : `wt-${path.basename(ctx.worktree_path).toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
      const SAFE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/
      const projectName = SAFE_PROJECT_NAME.test(rawProjectName) && rawProjectName.length <= 128
        ? rawProjectName
        : `wt-${path.basename(ctx.worktree_path).toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
      const snapshotContent = fs.readFileSync(snapshotPath)
      // 'database' is the postgres service name defined in compose.yml.
      const restoreResult = spawnSync('docker', [
        'compose', '-p', projectName,
        'exec', '-T', 'database',
        'psql', '-U', 'postgres', '-d', 'postgres',
      ], { input: snapshotContent, stdio: 'pipe', timeout: 120_000 })
      if (restoreResult.status === 0) {
        console.log('[resume] DB snapshot restored')
        fs.unlinkSync(snapshotPath)
        console.log('[resume] DB snapshot deleted after restore')
      } else {
        logger.warn(`[resume] WARNING: DB snapshot restore failed (non-fatal): ${restoreResult.stderr?.toString()}`)
      }
    }
  }

  // Step F — launch loop in a detached tmux session
  // Include a timestamp suffix to avoid collisions when a process is resumed multiple times.
  const sessionName = `resume-${id.slice(0, 8)}-${Date.now()}`

  let evalBranch = 'unknown'
  try {
    evalBranch = execFileSync('git', ['-C', ctx.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim()
  } catch {
    // ignore — default to 'unknown'
  }

  // Use tmux -e flags to inject critical env vars into the new session.
  // { env: fullEnv } on execFileSync only affects the tmux command process, NOT the
  // created session — new sessions inherit from the tmux server's environment.
  // Variables already in the server env (DATABASE_URL / SKILL_NETWORKS_DATABASE_URL,
  // ANTHROPIC_API_KEY, SUPABASE_*) are inherited automatically; only session-specific
  // vars that differ per-resume need to be set explicitly.
  const criticalEnvEntries: [string, string][] = [
    ['EVAL_PROCESS_ID', id],
    ['WORKTREE_PATH', ctx.worktree_path],
    ['LOOP_CMD', ctx.loop_cmd],
    ['NODE_OPTIONS', `--import ${ctx.worktree_path}/services/credential-proxy/interceptor-boot.mjs`],
    ['EVAL_BRANCH', evalBranch],
    // Pass SKILL_NETWORKS_CLI so resumed loop scripts can call lifecycle commands
    ['SKILL_NETWORKS_CLI', process.env.SKILL_NETWORKS_CLI ?? 'pnpm exec duoidal'],
  ]
  const tmuxEnvArgs: string[] = []
  for (const [key, value] of criticalEnvEntries) {
    tmuxEnvArgs.push('-e', `${key}=${value}`)
  }

  // Split loop_cmd into argv to avoid passing through sh -c (prevents shell injection).
  // loop_cmd is validated above to start with 'npx tsx utils/loop/' so splitting on
  // whitespace is safe — paths within that prefix never contain spaces.
  const loopArgv = ctx.loop_cmd.split(/\s+/).filter(Boolean)
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', sessionName, ...tmuxEnvArgs, '-c', ctx.worktree_path, ...loopArgv])
  } catch (tmuxErr) {
    await adapter.failProcess(id, `tmux new-session failed: ${tmuxErr instanceof Error ? tmuxErr.message : String(tmuxErr)}`)
    throw tmuxErr
  }

  console.log(`resumed process ${id} in tmux session ${sessionName}`)
}

// ── amend ───────────────────────────────────────────────────────────────────────

async function amendProcess(id: string, appendText: string): Promise<void> {
  if (!UUID_RE.test(id)) {
    throw new Error('--id must be a valid UUID')
  }

  const proc = await getAdapter().getProcessById(id)
  if (!proc) {
    throw new Error(`Process not found: ${id}`)
  }

  if (proc.skill_resource_id == null) {
    throw new Error(`Process ${id} has no skill_resource_id — cannot amend goal`)
  }

  if (proc.worktree_path == null || !fs.existsSync(proc.worktree_path)) {
    throw new Error(`Process ${id} has no valid worktree_path`)
  }

  const goalFile = path.join(proc.worktree_path, 'workspace', 'goal.md')
  const before = fs.readFileSync(goalFile, 'utf-8')
  const after = before + '\n' + appendText
  fs.writeFileSync(goalFile, after, 'utf-8')

  try {
    await getUnscopedAdapter().updateResourceContent(proc.skill_resource_id, after)
  } catch (err) {
    logger.error(`Failed to update goal resource in DB: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }

  await getUnscopedAdapter().insertAgentEvent({
    processId: id,
    processName: proc.name,
    resourceId: proc.skill_resource_id,
    source: 'goal_amended',
    payload: { before, after },
  })

  console.log(`Amended goal for process ${id}`)
}

// ── restart ─────────────────────────────────────────────────────────────────────

async function restartProcess(deadId: string): Promise<string> {
  if (!UUID_RE.test(deadId)) {
    throw new Error('--id must be a valid UUID')
  }

  const adapter = getAdapter()

  // Preflight check: validate process exists and status allows restart
  const dead = await adapter.getProcessById(deadId)
  if (!dead) {
    throw new Error(`Process not found: ${deadId}`)
  }

  const RESTARTABLE = ['failed', 'completed', 'blocked']
  if (!RESTARTABLE.includes(dead.status)) {
    throw new Error(`Cannot restart process with status '${dead.status}': only failed, completed, or blocked processes can be restarted`)
  }

  // Pre-flight checks for blocked processes with a worktree (validate before creating new process)
  if (dead.status === 'blocked' && dead.worktree_path) {
    if (!fs.existsSync(dead.worktree_path)) {
      throw new Error(`Cannot restart blocked process ${deadId}: worktree not found at ${dead.worktree_path}`)
    }
  }

  const { newId, originalProcess } = await adapter.restartProcess(deadId)

  // For blocked processes with a worktree, launch into tmux
  if (originalProcess.status === 'blocked' && originalProcess.worktree_path) {
    const worktreePath = originalProcess.worktree_path
    const newName = `${originalProcess.name}-r`
    const launchPath = path.join(worktreePath, 'utils/dispatch/steps/launch.ts')
    const slug = newName.replace(/[^a-z0-9-]/gi, '-').slice(0, 40)
    const launchArgs = ['tsx', launchPath, '--slug', slug, '--worktree', worktreePath, '--process-id', newId]
    // Use custom loop script if present in the worktree workspace
    const customLoop = path.join(worktreePath, 'workspace', 'run.ts')
    if (fs.existsSync(customLoop)) {
      launchArgs.push('--loop-script', customLoop)
    }
    execFileSync(
      'npx',
      launchArgs,
      { cwd: worktreePath, stdio: 'inherit', timeout: 30_000 }
    )
  }

  return newId
}
