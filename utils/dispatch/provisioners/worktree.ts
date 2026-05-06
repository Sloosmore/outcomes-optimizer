/**
 * Worktree provisioner — creates a git worktree for a dispatch run,
 * initialises the process row in the DB, fetches the goal, and tears down.
 *
 * Creates an isolated git worktree on local disk (not FUSE) so that
 * native binaries (esbuild, tsc, node) can execute. Worktrees are
 * persistent across runs; if the directory already exists, creation is skipped.
 */

import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import type { Provisioner } from '../provisioner.js'
import type { ProvisionContext } from '../provision-context.js'
import { SAFE_BRANCH_RE } from '../../types.js'
import { createEventService, EventType, createWatchdog } from '@skill-networks/agent-events'
import { getSupabaseServiceKey, getSupabaseUrl } from '@skill-networks/database/constants'

const SKILL_RESOURCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Default source repo path — in-memory clone seeded by start-openclaw.sh on every boot.
 *  Falls back here when neither --repo nor WORKTREE_REPO is set.
 *  Previously defaulted to /mnt/r2/workspace/outcomes-optimizer (R2 FUSE mount) which fails
 *  when the FUSE mount is unavailable or slow. */
const DEFAULT_REPO_PATH = '/root/repos/outcomes-optimizer'

/** Timeout for git operations. */
const GIT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** Reject slugs that could escape paths or inject git arguments. */
function validateSlug(slug: string): void {
  if (!slug || !/^[a-zA-Z0-9_\-.]+$/.test(slug)) {
    throw new Error(`[worktree] Invalid slug (must be alphanumeric with _ - .): ${slug}`)
  }
}

/** Reject path arguments that start with '-' to prevent git flag injection. */
function safePath(p: string, label: string): string {
  if (p.startsWith('-')) {
    throw new Error(`[worktree] ${label} must not start with '-': ${p}`)
  }
  return p
}

/**
 * Copies src directory to dest recursively. Throws on error (caller decides fatal vs non-fatal).
 * dereference: false — symlinks are preserved as symlinks, not followed.
 */
export function copyWorkspace(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(src, dest, { recursive: true, dereference: false })
}

export async function provision(
  ctx: ProvisionContext,
  slug: string,
  opts?: Record<string, string>,
): Promise<void> {
  validateSlug(slug)

  const repo = safePath(opts?.repo ?? process.env['WORKTREE_REPO'] ?? DEFAULT_REPO_PATH, 'repo')
  const baseDir = safePath(opts?.['base-dir'] ?? '/root/dispatch', 'base-dir')
  const worktreePath = safePath(opts?.worktree || opts?.path || path.join(baseDir, slug), 'path')
  const branchName = safePath(opts?.branch ?? `boot/${slug}`, 'branch')

  // In-place mode: worktree IS the repo — both must be explicitly provided and identical
  const isInPlace =
    Boolean(opts?.worktree) &&
    Boolean(opts?.repo) &&
    path.resolve(opts?.worktree ?? '') === path.resolve(opts?.repo ?? '')

  // Path containment guard (skip for in-place mode)
  if (!isInPlace) {
    const resolved = path.resolve(worktreePath)
    const resolvedBase = path.resolve(baseDir)
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
      throw new Error(`[worktree] Path escapes base directory: ${resolved}`)
    }
  }

  // Validate source repo is accessible before attempting worktree creation
  if (!isInPlace && !fs.existsSync(repo)) {
    throw new Error(
      `[worktree] Source repo not found at ${repo} — was start-openclaw.sh boot completed? Set WORKTREE_REPO to override the default path.`,
    )
  }

  // Track whether worktree already exists (in-place or pre-existing directory)
  const isExisting = isInPlace || fs.existsSync(worktreePath)

  // Best-effort: fetch latest main before creating worktree.
  // Only fetch (safe, updates remote-tracking refs) — do NOT merge into the
  // shared source repo, which would mutate HEAD and create a race condition
  // when multiple dispatches run concurrently.
  let fetchedMain = false
  if (!isInPlace && !isExisting && !opts?.['skip-fetch']) {
    try {
      execFileSync('git', ['-C', repo, 'fetch', 'origin', 'main'], {
        stdio: 'pipe',
        timeout: 30_000,
      })
      fetchedMain = true
    } catch (err) {
      console.warn(`[worktree] WARNING: Failed to fetch origin/main (best-effort, continuing): ${(err as Error).message}`)
    }
  }

  if (isInPlace) {
    console.log(`[worktree] In-place mode: using repo itself as worktree: ${worktreePath}`)
  } else if (isExisting) {
    console.log(`[worktree] Worktree already exists: ${worktreePath} — skipping creation`)
  } else {
    // If fetch succeeded, base the new branch on origin/main so it includes the
    // latest commits without mutating the shared repo's HEAD.
    const baseRef = fetchedMain ? 'origin/main' : undefined
    try {
      execFileSync(
        'git',
        ['-C', repo, 'worktree', 'add', worktreePath, '-b', branchName, ...(baseRef ? [baseRef] : [])],
        { stdio: 'pipe', timeout: GIT_TIMEOUT_MS },
      )
    } catch (err) {
      const stderr = (err as NodeJS.ErrnoException & { stderr?: Buffer })?.stderr?.toString() ?? ''
      if (fs.existsSync(worktreePath) || stderr.includes('already checked out')) {
        console.log(`[worktree] Worktree already exists (concurrent creation): ${worktreePath}`)
      } else if (stderr.includes('already exists')) {
        // Branch exists but worktree directory was deleted — check it out without -b
        console.log(`[worktree] Branch ${branchName} exists; checking out without -b`)
        execFileSync('git', ['-C', repo, 'worktree', 'add', worktreePath, branchName], {
          stdio: 'pipe',
          timeout: GIT_TIMEOUT_MS,
        })
      } else {
        throw err
      }
    }
  }

  // Strip stale COMPLETE signal on re-provision so the next epoch starts fresh
  if (isExisting) {
    const progressPath = path.join(worktreePath, 'workspace', 'progress.md')
    if (fs.existsSync(progressPath)) {
      const progressContent = fs.readFileSync(progressPath, 'utf-8')
      const head = progressContent.split('\n').slice(0, 10).join('\n')
      if (/^(\*{0,2})COMPLETE\1(\s|$)/m.test(head)) {
        fs.unlinkSync(progressPath)
        console.log('[worktree] Removed stale COMPLETE signal from workspace/progress.md (re-provisioning)')
      }
    }
  }

  // Create or recover process ID — fresh worktrees call agent-core process init,
  // existing worktrees read EVAL_PROCESS_ID from the .env written by a prior run.
  if (isExisting) {
    const envFile = path.join(worktreePath, '.env')
    if (fs.existsSync(envFile)) {
      const envContent = fs.readFileSync(envFile, 'utf-8')
      const match = envContent.match(/^EVAL_PROCESS_ID=["']?([^"'\n]+)["']?/m)
      if (match) {
        ctx.processId = match[1]
      } else {
        console.log('[worktree] No EVAL_PROCESS_ID in existing .env — legacy worktree')
      }
    }
  }

  if (!ctx.processId) {
    const runType = opts?.['run-type'] ?? 'local'
    const skillResourceId = opts?.['skill-resource-id']
    const parentProcessId = opts?.['parent-process-id']
    if (parentProcessId && !SKILL_RESOURCE_ID_RE.test(parentProcessId)) {
      throw new Error(`[worktree] Invalid --parent-process-id (must be a UUID): ${parentProcessId}`)
    }
    const projectId = opts?.['project-id']

    // Build request body — only include optional params when present
    const body: Record<string, unknown> = {
      p_name: slug,
      p_branch: branchName,
      p_run_type: runType,
      p_worktree_path: worktreePath,
    }
    if (!opts?.unlinked && skillResourceId && SKILL_RESOURCE_ID_RE.test(skillResourceId)) {
      body.p_skill_resource_id = skillResourceId
    }
    if (parentProcessId) body.p_parent_process_id = parentProcessId
    if (projectId) body.p_project_id = projectId

    const supabaseUrl = getSupabaseUrl()
    const supabaseKey = getSupabaseServiceKey()

    let initResp: Response
    try {
      initResp = await fetch(`${supabaseUrl}/rest/v1/rpc/init_process`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new Error(`[worktree] Failed to create process for ${slug}`, { cause: e })
    }
    if (!initResp.ok) {
      const errText = await initResp.text().catch(() => '(no body)')
      throw new Error(`[worktree] init_process RPC returned ${initResp.status}: ${errText}`)
    }
    // PostgREST wraps single-row RPC results in an array — unwrap if needed.
    const initRaw = await initResp.json() as { process_id?: string } | { process_id?: string }[]
    const initData = Array.isArray(initRaw) ? initRaw[0] : initRaw
    ctx.processId = initData?.process_id ?? ''
    if (!SKILL_RESOURCE_ID_RE.test(ctx.processId)) {
      throw new Error(`[worktree] process init returned non-UUID processId: ${ctx.processId}`)
    }
    console.log(`[worktree] Created process ${ctx.processId} with worktree_path=${worktreePath}${parentProcessId ? `, parent_process_id=${parentProcessId}` : ''}`)
  }

  if (ctx.processId) {
    const eventService = createEventService()
    eventService?.emit({ source: EventType.WORKTREE_PROVISIONED, payload: { process_id: ctx.processId, branch: branchName }, resource_id: null })
    createWatchdog(ctx.processId)
  }

  ctx.worktreePath = worktreePath

  // Seed worktree env from the source repo's .env (if it exists).
  // This propagates sandbox-level vars (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
  // DATABASE_URL, etc.) that don't change per-worktree.
  // Reserved keys managed by ProvisionContext.writeEnv() are skipped — they must
  // not be overridden by stale values from the source repo .env because envMap
  // entries are applied after the hardcoded fields in writeEnv()/toShellEnv().
  if (!isInPlace) {
    const RESERVED_ENV_KEYS = new Set(['WORKTREE_PATH', 'EVAL_PROCESS_ID', 'SKILL_RESOURCE_ID', 'SKILL_NETWORKS_CLI'])
    const repoEnvPath = path.join(repo, '.env')
    if (fs.existsSync(repoEnvPath)) {
      const text = fs.readFileSync(repoEnvPath, 'utf-8')
      for (const rawLine of text.split('\n')) {
        let line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        if (line.startsWith('export ')) line = line.slice(7).trim()
        const eqIdx = line.indexOf('=')
        if (eqIdx < 1) continue
        const key = line.slice(0, eqIdx).trim()
        if (RESERVED_ENV_KEYS.has(key)) continue
        let value = line.slice(eqIdx + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        ctx.setEnv(key, value)
      }
      console.log(`[worktree] Seeded env from ${repoEnvPath}`)
    }
  }

  ctx.contextFragments.push('## Worktree\n\nWorktree path: ' + worktreePath + '\n')

  // If a skill resource ID was provided, fetch the skill content and write workspace/goal.md.
  // Callers source provision-output.env and get SKILL_RESOURCE_ID directly; no separate
  // fetch step needed in headless dispatch scripts.
  const skillResourceId = opts?.['skill-resource-id']
  if (skillResourceId) {
    if (!SKILL_RESOURCE_ID_RE.test(skillResourceId)) {
      throw new Error(`[worktree] Invalid --skill-resource-id (must be a UUID): ${skillResourceId}`)
    }
    const supabaseUrl = getSupabaseUrl()
    const supabaseKey = getSupabaseServiceKey()

    let skillResp: Response
    try {
      skillResp = await fetch(`${supabaseUrl}/rest/v1/rpc/fetch_skill_content`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_skill_resource_id: skillResourceId }),
      })
    } catch (e) {
      throw new Error(`[worktree] Failed to fetch skill content for ${skillResourceId}`, { cause: e })
    }
    if (!skillResp.ok) {
      const errText = await skillResp.text().catch(() => '(no body)')
      throw new Error(`[worktree] fetch_skill_content RPC returned ${skillResp.status}: ${errText}`)
    }
    // PostgREST wraps single-row RPC results in an array — unwrap if needed.
    const skillRaw = await skillResp.json() as { content?: string } | { content?: string }[] | null
    const skillData = Array.isArray(skillRaw) ? skillRaw[0] : skillRaw
    const content = skillData?.content
    if (!content) throw new Error(`[worktree] Skill resource ${skillResourceId} has no config.content`)
    fs.mkdirSync(path.join(worktreePath, 'workspace'), { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'workspace', 'goal.md'), content, { encoding: 'utf-8' })
    ctx.skillResourceId = skillResourceId
    console.log(`[worktree] Wrote workspace/goal.md from skill resource ${skillResourceId}`)
  }

  console.log(`WORKTREE_PATH=${worktreePath}`)
}

export async function teardown(ctx: ProvisionContext, slug: string): Promise<void> {
  validateSlug(slug)

  // Step 1: Validate inputs
  if (!ctx.worktreePath) {
    console.warn('[worktree] WARNING: worktreePath not set — cannot archive workspace')
    return
  }
  if (!path.isAbsolute(ctx.worktreePath)) {
    throw new Error(`[worktree] worktreePath must be an absolute path: ${ctx.worktreePath}`)
  }
  if (ctx.skillResourceId && !SKILL_RESOURCE_ID_RE.test(ctx.skillResourceId)) {
    throw new Error(`[worktree] Invalid skillResourceId: ${ctx.skillResourceId}`)
  }
  const worktreePath = ctx.worktreePath

  // Step 2: Best-effort final commit
  try {
    execFileSync('git', ['-C', worktreePath, 'add', '-A'], { stdio: 'pipe', timeout: 30_000 })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'teardown: final state'], { stdio: 'pipe', timeout: 30_000 })
    console.log('[worktree] Final commit created')
  } catch (err) {
    console.log(`[worktree] Final commit skipped (no changes or error): ${(err as Error).message}`)
  }

  // Step 3: Push to origin
  try {
    const rawBranch = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    }).trim()
    if (!rawBranch || rawBranch === 'HEAD' || !SAFE_BRANCH_RE.test(rawBranch)) {
      console.warn(`[worktree] WARNING: branch name failed safety check (got "${rawBranch}") — skipping push`)
    } else {
      execFileSync('git', ['-C', worktreePath, 'push', '--force-with-lease', 'origin', `HEAD:${rawBranch}`], {
        stdio: 'pipe',
        timeout: 60_000,
      })
      console.log(`[worktree] Pushed branch ${rawBranch} to origin`)
    }
  } catch (err) {
    console.warn(`[worktree] WARNING: push failed — worktree will still be deleted: ${(err as Error).message}`)
  }

  // Step 4: R2 archive (always runs, regardless of push result)
  const historyMount = process.env['R2_HISTORY_MOUNT']
  if (!historyMount) {
    console.log('[worktree] R2_HISTORY_MOUNT not set — skipping workspace archive')
  } else {
    if (!path.isAbsolute(historyMount)) {
      console.warn(`[worktree] WARNING: R2_HISTORY_MOUNT is not an absolute path (${historyMount}) — skipping archive`)
    } else {
      const skillId = ctx.skillResourceId ?? slug
      if (!ctx.skillResourceId) {
        console.warn('[worktree] WARNING: skillResourceId not set — using slug as fallback key')
      }
      const workspaceDir = path.join(worktreePath, 'workspace')
      if (!fs.existsSync(workspaceDir)) {
        console.log('[worktree] No workspace/ to archive')
      } else {
        const dest = path.join(historyMount, skillId, 'workspace')
        try {
          copyWorkspace(workspaceDir, dest)
          console.log(`[worktree] Archived workspace/ → ${dest}`)
        } catch (err) {
          console.warn(`[worktree] WARNING: archive failed (non-fatal): ${err}`)
        }
      }
    }
  }

  // Step 5: Delete worktree (unconditionally — disk space must be reclaimed regardless of push outcome)
  const repo = safePath(process.env['WORKTREE_REPO'] ?? DEFAULT_REPO_PATH, 'repo')
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktreePath], { stdio: 'pipe', timeout: 30_000 })
    console.log(`[worktree] Removed worktree: ${worktreePath}`)
  } catch (err) {
    console.log(`[worktree] Worktree remove failed, falling back to rmSync + prune: ${(err as Error).message}`)
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'pipe', timeout: 10_000 })
    } catch (pruneErr) {
      console.log(`[worktree] Prune also failed (non-fatal): ${(pruneErr as Error).message}`)
    }
  }
  fs.rmSync(worktreePath, { recursive: true, force: true })
  console.log(`[worktree] Deleted directory: ${worktreePath}`)
}

export const worktreeProvisioner: Provisioner = {
  name: 'worktree',
  provision,
  teardown,
}

export default worktreeProvisioner
