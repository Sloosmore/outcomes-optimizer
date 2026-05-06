/**
 * Generalized dispatch entry point.
 *
 * Provisions a worktree and launches a tmux loop session for a skill.
 * Works as both a library (import validateSkillConfig/dispatchRun) and a CLI:
 *
 *   npx tsx utils/dispatch/dispatch.ts --skill-resource-id <uuid> --epochs 10
 */

import { execFile, execFileSync, spawn } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, isAbsolute, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getUnscopedAdapter } from '@duoidal/agent-core'
import { getSupabaseServiceKey, getSupabaseUrl } from '@skill-networks/database/constants'
import { launch } from './steps/launch.js'
import { getCliCommand } from '../cli-prefix.js'

// Used only for short-lived child processes whose stdout we genuinely want to
// capture as a return value (e.g. `duoidal process status --json`). For
// long-running children whose progress we want to *see*, use `spawnInherit`
// below — execFile silently buffers stdout/stderr regardless of stdio: 'inherit'.
const execFileAsync = promisify(execFile)

/**
 * Spawn a child process with stdio inherited from this process. Resolves on
 * exit code 0; rejects with a descriptive Error otherwise.
 *
 * Replaces the prior `promisify(execFile)` usage. `execFile`'s options bag
 * does not honour `stdio: 'inherit'` — execFile *always* buffers stdout and
 * stderr internally and only surfaces them via the resolved value. That
 * silently swallowed every line printed by `provision.prebuilt.mjs` (worktree
 * status, [provision] step logs, turbo build output, errors). For ~30 minutes
 * during the May 4 incident, dispatch looked stuck mid-provision when in fact
 * provision was working and emitting clear progress — it just had nowhere to
 * go.
 *
 * `spawn` honours `stdio: 'inherit'` so child output streams directly to the
 * tmux pane (or the operator's terminal) in real time.
 */
function spawnInherit(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve()
      reject(new Error(
        `${cmd} ${args[0] ?? ''} exited with ${signal ? `signal ${signal}` : `code ${code ?? '(unknown)'}`}`,
      ))
    })
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CronSkillConfig {
  metric?: string  // optional — omitting is valid; if present must be string
  content: string  // canonical skill instructions (was: prompt)
  epochs: number
  worktree: true   // always true — every skill runs in a provisioned worktree via the epoch loop. There is no inline path.
  git: boolean
  pr?: boolean
}

export function validateSkillConfig(config: unknown): config is CronSkillConfig {
  if (config === null || typeof config !== 'object') return false
  const c = config as Record<string, unknown>
  // metric is optional — omitting it is valid, but if present it must be a string
  if ('metric' in c && typeof c.metric !== 'string') return false
  if (typeof c.content !== 'string') return false
  if (typeof c.epochs !== 'number') return false
  if (c.worktree !== true) return false  // worktree is always true — no inline path exists
  if (typeof c.git !== 'boolean') return false
  if ('pr' in c && typeof c.pr !== 'boolean') return false
  return true
}

/**
 * Parses a provision-output.env file and returns a map of key → value.
 * Values are shell-quoted (double-quoted with escaped chars); strips outer double-quotes.
 */
function parseProvisionOutputEnv(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, 'utf-8')
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue
    const key = line.slice(0, eqIdx).trim()
    if (!key) continue
    let value = line.slice(eqIdx + 1).trim()
    // Strip outer double-quotes added by shellQuote()
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
      // Unescape shell escape sequences: \\, \", \$, \`, \n
      // Process \\\\ first so it does not interfere with subsequent replacements
      value = value
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\`/g, '`')
        .replace(/\\\$/g, '$')
        .replace(/\\"/g, '"')
    }
    result[key] = value
  }
  return result
}

export async function collect(
  skillConfig: CronSkillConfig,
  skillId: string,
  opts?: { provisions?: string[]; repo?: string; fresh?: boolean; projectId?: string; parentProcessId?: string; buildLocal?: boolean; skipBuildLocal?: boolean },
): Promise<'completed' | 'failed'> {
  // Validate
  if (!validateSkillConfig(skillConfig)) {
    console.warn(`[dispatch] Invalid skill config for ${skillId}: missing or wrong-typed fields`)
    return 'failed'
  }

  // Enforce UUID invariant — collect() only accepts skill resource UUIDs.
  // The --prompt path that allowed slug-derived skillIds was removed; every caller
  // must pass a DB-backed UUID so --skill-resource-id is always meaningful.
  if (!UUID_RE.test(skillId)) {
    console.warn(`[dispatch] collect() requires a UUID skillId, got: ${skillId}`)
    return 'failed'
  }

  // Derive slug — fresh:true appends a timestamp so each dispatch gets a new worktree
  // provisioned from the latest main, with no stale state from prior runs.
  const baseSlug = skillId.slice(0, 8)
  const slug = opts?.fresh ? `${baseSlug}-${Date.now().toString(36).slice(-5)}` : baseSlug

  // Spawn provision to set up a worktree (async — does not block the event loop)
  // Default repo: /root/repos/outcomes-optimizer (in-memory clone, seeded on boot).
  // WORKTREE_REPO env var overrides this if a different source repo is needed.
  // Use the pre-compiled provision bundle to eliminate tsx cold-start overhead (~1.5s).
  // Falls back to npx tsx provision.ts when the bundle is absent (dev environments
  // before build-bundles.mjs has been run).
  const provisionBundle = join(dirname(fileURLToPath(import.meta.url)), 'provision.prebuilt.mjs')
  const useProvisionBundle = existsSync(provisionBundle)
  const provisionsList = opts?.provisions?.length ? opts.provisions : ['worktree', 'compose']
  const provisionArgs = useProvisionBundle
    ? [provisionBundle, '--slug', slug, '--skill-resource-id', skillId]
    : ['tsx', 'utils/dispatch/provision.ts', '--slug', slug, '--skill-resource-id', skillId]
  for (const p of provisionsList) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p)) {
      throw new Error(`Invalid provisioner name: "${p}" — must match /^[a-z0-9][a-z0-9-]*$/`)
    }
    provisionArgs.push('--provision', p)
  }

  if (opts?.projectId) {
    provisionArgs.push('--project-id', opts.projectId)
  }

  if (opts?.parentProcessId) {
    provisionArgs.push('--parent-process-id', opts.parentProcessId)
  }

  if (opts?.buildLocal) provisionArgs.push('--build-local')
  if (opts?.skipBuildLocal) provisionArgs.push('--skip-build-local')

  // If the outer `duoidal execute` routed this dispatch across an SSH hop into a
  // remote container, waypoint-router sets DUOIDAL_RUN_TYPE to the originating
  // server name (e.g. 'openclaw'). The process row's run_type should then reflect
  // that this is a remote/cloud run instead of defaulting to 'local' — otherwise
  // a dispatch from laptop→openclaw produces a row labelled `run_type=local`
  // that misleads anyone reading the DB about where the agent actually executes.
  //
  // The `processes.run_type` column has a CHECK constraint restricting it to
  // {'cloud','local','moltbot'}, so any non-empty remote server name maps to
  // 'cloud'. When DUOIDAL_RUN_TYPE is unset we emit no flag and the worktree
  // provisioner's existing default ('local') applies — preserving today's
  // behavior for the local-tmux path.
  const dispatchRunType = process.env.DUOIDAL_RUN_TYPE
  if (dispatchRunType && dispatchRunType.length > 0) {
    provisionArgs.push('--run-type', 'cloud')
  }

  const repo = opts?.repo ?? process.env.WORKTREE_REPO
  if (repo) {
    if (!isAbsolute(repo)) {
      throw new Error(`repo must be an absolute path, got: ${repo}`)
    }
    provisionArgs.push('--repo', repo)
  }

  // Pass DISPATCH_BASE_DIR through to provision.ts so the worktree provisioner
  // creates <base-dir>/<slug> under a writable local path instead of defaulting
  // to /root/dispatch (which only exists on the openclaw runtime container).
  // execute.ts sets DISPATCH_BASE_DIR for "server": "self" dispatch; provision.ts's
  // worktreeProvisioner respects --base-dir. If the env var is not set we leave
  // the provisioner's own /root/dispatch default in place.
  if (process.env.DISPATCH_BASE_DIR) {
    provisionArgs.push('--base-dir', process.env.DISPATCH_BASE_DIR)
  }
  // Always use an explicit cwd so the poller (or any caller) never depends on its
  // ambient working directory — a deleted worktree CWD causes ENOENT on uv_cwd.
  const provisionCwd = repo ?? '/root/repos/outcomes-optimizer'
  // Run with node (bundle) or npx (tsx fallback). Pass env: process.env explicitly so PATH
  // reaches the child — some contexts (e.g. `doppler run --`) rebuild the subprocess env
  // without PATH. Do NOT add `shell: true` — command-injection surface on composite inputs.
  // Use spawn (not execFile) because we genuinely need stdio inherited — see
  // spawnInherit's docstring for the silent-output bug this fixes.
  await spawnInherit(useProvisionBundle ? 'node' : 'npx', provisionArgs, {
    cwd: provisionCwd,
    env: process.env,
  })

  // Read provision-output.env from <dispatchBaseDir>/<slug>/provision-output.env
  const dispatchBaseDir = process.env.DISPATCH_BASE_DIR ?? '/root/dispatch'
  const outputDir = join(dispatchBaseDir, slug)
  const outputEnvPath = join(outputDir, 'provision-output.env')

  if (!existsSync(outputEnvPath)) {
    console.warn(`[dispatch] provision-output.env not found at ${outputEnvPath}`)
    return 'failed'
  }

  const env = parseProvisionOutputEnv(outputEnvPath)

  const processId = env['EVAL_PROCESS_ID']
  const worktreePath = env['WORKTREE_PATH']

  if (!processId) {
    console.warn(`[dispatch] EVAL_PROCESS_ID not found in provision-output.env`)
    return 'failed'
  }
  if (!worktreePath) {
    console.warn(`[dispatch] WORKTREE_PATH not found in provision-output.env`)
    return 'failed'
  }

  // Overwrite goal.md with the assembled content (includes prompt segments like
  // driver_discovery, goal, dispatch). The provisioner writes raw DB content but
  // the poller's buildAgentPrompt() assembles the full prompt with segments — that
  // assembled content is in skillConfig.content and must reach the agent.
  const goalPath = join(worktreePath, 'workspace', 'goal.md')
  if (existsSync(goalPath) && skillConfig.content) {
    writeFileSync(goalPath, skillConfig.content, 'utf-8')
  }

  try {
    // Guard: don't launch a loop for a process already in a terminal state.
    // This catches the case where provisioning created the process row but then
    // immediately failed (e.g. pnpm install error), leaving status = 'failed'.
    try {
      const [bin, prefixArgs] = getCliCommand()
      const statusJson = (await execFileAsync(
        bin, [...prefixArgs, 'process', 'status', '--id', processId, '--json'],
        { cwd: worktreePath, timeout: 15_000, env: process.env },
      )).stdout.trim()
      const { status } = JSON.parse(statusJson) as { status: string }
      if (status === 'failed' || status === 'completed') {
        console.warn(`[dispatch] Process ${processId} is already ${status} — skipping launch. Run 'duoidal process reset --id ${processId}' to retry.`)
        return 'failed'
      }
    } catch {
      // Status check is best-effort — if it fails (e.g. DB unreachable) proceed anyway
      console.warn(`[dispatch] Could not check process status for ${processId} — proceeding with launch`)
    }

    // Launch tmux session — skillId is always a UUID at this point (enforced above)
    await launch({ slug, worktreePath, processId, skillResourceId: skillId, maxEpochs: skillConfig.epochs, pr: skillConfig.pr })
  } catch (err) {
    // Fail-fast cleanup: mark the process row as failed before re-throwing.
    // getSupabaseServiceKey() throws when unset; cleanup is best-effort, so we
    // catch and fall back to empty string to preserve the existing opt-in check.
    const supabaseUrl = getSupabaseUrl()
    let supabaseServiceKey = ''
    try {
      supabaseServiceKey = getSupabaseServiceKey()
    } catch {
      supabaseServiceKey = ''
    }
    if (supabaseServiceKey) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/rpc/fail_process`, {
          method: 'POST',
          headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_process_id: processId, p_reason: (err as Error).message ?? String(err) }),
        })
      } catch (failErr) {
        console.warn('[dispatch] fail_process RPC call failed:', (failErr as Error).message)
      }
    }
    throw err
  }

  return 'completed'
}

export async function dispatchRun(
  row: { skill_id: string; skill_config: CronSkillConfig },
): Promise<'completed' | 'failed'> {
  // fresh:true — each cron dispatch gets a new worktree provisioned from latest main.
  // No stale state, no reset logic needed, always up to date.
  return collect(row.skill_config, row.skill_id, { fresh: true })
}

// Named export alias for workspace consumers
export { dispatchRun as dispatch }

// CLI entry point
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  void (async () => {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Dispatch CLI — provision a worktree and launch a loop in tmux.

Usage:
  npx tsx utils/dispatch/dispatch.ts --skill-resource-id <uuid> [options]

Required:
  --skill-resource-id <uuid>   Fetch goal from DB by resource ID

Options:
  --epochs <n>                 Max epochs (default: 10)
  --max-epochs <n>             Alias for --epochs
  --repo <path>                Source repo for worktree (passed to provisioner; default: WORKTREE_REPO env or /root/repos/outcomes-optimizer)
  --provision <name>           Provisioner to run (repeatable, default: worktree)
  --pr                         Open PR on completion
  --no-pr                      Skip PR (default)
  --git                        Enable git commits per epoch (default)
  --no-git                     Disable git commits
  --parent-process-id <uuid>   Set parent process ID for child process hierarchy tracking
  --project-id <uuid>          Associate process with a project (optional)
  --unlinked                   Dispatch without a runs link (logs WARNING); use when no runs link exists yet
  --build-local                Use locally-built CLI binary (checks node_modules/.bin/duoidal after compose)
  --skip-build-local           Force published CLI even when --build-local is configured

Examples:
  # Basic cloud dispatch
  npx tsx utils/dispatch/dispatch.ts --skill-resource-id 12345678-1234-1234-1234-123456789abc --epochs 10

  # Dispatch from a specific worktree with compose
  npx tsx utils/dispatch/dispatch.ts --skill-resource-id 12345678-1234-1234-1234-123456789abc \\
    --repo /root/dispatch/my-worktree \\
    --provision worktree --provision compose

Environment:
  WORKTREE_REPO          Override default source repo path
  DISPATCH_BASE_DIR      Override where worktrees are created (default: /root/dispatch)
  DATABASE_URL           Required for --skill-resource-id and process lifecycle
  SKILL_NETWORKS_DATABASE_URL  Fallback for DATABASE_URL`)
    process.exit(0)
  }

  let skillResourceId: string | undefined
  let epochsFromFlag: number | undefined
  let maxEpochsFromFlag: number | undefined
  let git = true
  let pr = false
  let provisions: string[] = []
  let repoPath: string | undefined
  let unlinked = false
  let parentProcessId: string | undefined
  let projectId: string | undefined
  let buildLocal = false
  let skipBuildLocal = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--skill-resource-id' && args[i + 1]) {
      skillResourceId = args[++i]
    } else if (arg === '--epochs' && args[i + 1]) {
      epochsFromFlag = parseInt(args[++i], 10)
    } else if (arg === '--max-epochs' && args[i + 1]) {
      maxEpochsFromFlag = parseInt(args[++i], 10)
    } else if (arg === '--git') {
      git = true
    } else if (arg === '--no-git') {
      git = false
    } else if (arg === '--pr') {
      pr = true
    } else if (arg === '--no-pr') {
      pr = false
    } else if (arg === '--provision' && args[i + 1]) {
      provisions.push(args[++i])
    } else if (arg === '--repo' && args[i + 1]) {
      repoPath = args[++i]
    } else if (arg === '--unlinked') {
      unlinked = true
    } else if (arg === '--parent-process-id' && args[i + 1]) {
      parentProcessId = args[++i]
    } else if (arg === '--project-id' && args[i + 1]) {
      projectId = args[++i]
    } else if (arg === '--build-local') {
      buildLocal = true
    } else if (arg === '--skip-build-local') {
      skipBuildLocal = true
    }
  }

  if (parentProcessId && !UUID_RE.test(parentProcessId)) {
    console.error('[dispatch] --parent-process-id must be a valid UUID')
    process.exit(1)
  }
  if (projectId && !UUID_RE.test(projectId)) {
    console.error('[dispatch] --project-id must be a valid UUID')
    process.exit(1)
  }

  // --epochs wins over --max-epochs if both provided
  const epochs = epochsFromFlag ?? maxEpochsFromFlag ?? 10

  // Load skill content from DB by resource id
  let skillId: string
  let resolvedContent: string

  if (skillResourceId) {
    skillId = skillResourceId
    const [bin, prefixArgs] = getCliCommand()
    const raw = execFileSync(bin, [...prefixArgs, 'show', '--id', skillResourceId, '--json'], {
      encoding: 'utf-8',
      env: process.env,
    })
    const rawParsed = JSON.parse(raw) as { name?: string; config?: unknown }
    // config may be serialized as a JSON string inside the JSON (JSONB text value).
    // Normalize to an object so .config.content is always accessible.
    const configObj: { content?: string } | undefined = typeof rawParsed.config === 'string'
      ? JSON.parse(rawParsed.config) as { content?: string }
      : rawParsed.config as { content?: string } | undefined
    const parsed = { name: rawParsed.name, config: configObj }

    // Check for runs link (UUID path only) — fail fast before provisioning
    {
      const skillName: string = parsed.name ?? ''
      let linkCount = 0
      try {
        // Use getUnscopedAdapter() — dispatch is infrastructure that needs unscoped DB access
        const links = await getUnscopedAdapter().listLinksToId({ toId: skillResourceId, linkType: 'runs' })
        linkCount = links.length
      } catch (err) {
        process.stderr.write(`[dispatch] WARNING: runs-link check failed (${(err as Error).message ?? String(err)}); assuming no link\n`)
        linkCount = 0
      }
      if (linkCount === 0) {
        const skillLabel = skillName ? `${skillName} (${skillResourceId})` : skillResourceId
        if (unlinked) {
          process.stderr.write(`[dispatch] WARNING: dispatching without runs link for ${skillLabel}. Create one with: npx duoidal link --from-id <agent-or-user-id> --to-id ${skillResourceId} --type runs\n`)
        } else {
          process.stderr.write(`[dispatch] Error: no runs link found for ${skillLabel}. Pass --unlinked to bypass this check.\n`)
          process.exit(1)
        }
      }
    }

    // Auto-resolve projectId from the skill resource's parent link if not explicitly set
    if (!projectId) {
      try {
        // Use getUnscopedAdapter() — dispatch is infrastructure that needs unscoped DB access
        const link = await getUnscopedAdapter().findLinkByFromAndType(skillResourceId, 'parent')
        if (link?.to_id) {
          projectId = link.to_id
        } else {
          process.stderr.write(`[dispatch] WARNING: no parent link found for ${skillResourceId} — projectId will be undefined\n`)
        }
      } catch (err) {
        process.stderr.write(`[dispatch] WARNING: project auto-resolve failed (${(err as Error).message ?? String(err)}); continuing without projectId\n`)
      }
    }

    if (!parsed?.config?.content) {
      console.error('[dispatch] Could not extract .config.content from agent-core show output')
      process.exit(1)
    }
    resolvedContent = parsed.config.content
  } else {
    console.error('[dispatch] --skill-resource-id <uuid> is required')
    process.exit(1)
  }

  const config: CronSkillConfig = {
    content: resolvedContent,
    epochs,
    worktree: true,
    git,
    pr,
  }

  try {
    const result = await collect(config, skillId, {
      provisions: provisions.length > 0 ? provisions : undefined,
      repo: repoPath,
      parentProcessId,
      projectId,
      buildLocal,
      skipBuildLocal,
    })
    if (result === 'failed') {
      console.error('[dispatch] collect() returned failed')
      process.exit(1)
    }
    // Print the session name (slug = first 8 chars of skillId)
    const slug = skillId.slice(0, 8)
    console.log(`Session: ${slug}`)
    process.exit(0)
  } catch (err: unknown) {
    console.error('[dispatch] Unexpected error:', (err as Error).message || err)
    process.exit(1)
  }
  })()
}
