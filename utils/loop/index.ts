/**
 * Ralph Loop - epoch-based optimization with CLI adapter
 *
 * Ported from orchestrator.sh to use consistent CLI adapter pattern.
 *
 * Usage:
 *   import { executeLoop } from './index'
 *   await executeLoop({ goal: '...', maxEpochs: 10 })
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
import { createHash } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { run } from '../run/index.js'
import { MAX_LOOP_DURATION_MS, SAFE_BRANCH_RE } from '../types.js'
import { getCliCommand } from '../cli-prefix.js'
import { openPRAdapter } from './adapters/open-pr.js'
import { StoryProgressAdapter } from './adapters/progress-adapter.js'
import { createEventService, EventType, createWatchdog } from '@skill-networks/agent-events'
import { getSupabaseServiceKey, getSupabaseUrl } from '@skill-networks/database/constants'
// SYSTEM.md now contains unified prompt (leader + optimization + policy)

// Max consecutive epochs without prd.json changes before aborting (thrashing detection)
const THRASHING_THRESHOLD = 3

// Buffer before max duration to allow graceful exit (15 minutes)
const DURATION_BUFFER_MS = 15 * 60 * 1000

export interface LoopConfig {
  goal: string
  maxEpochs: number
  testSetPath?: string
  workspaceDir?: string
  // New fields with defaults that preserve current behavior:
  worktree?: boolean   // default: true (existing behavior)
  git?: boolean        // default: true (commitEpoch runs when EVAL_BRANCH is set)
  pr?: boolean         // default: false (opt-in via --pr flag)
  epochs?: number      // alias for maxEpochs — if provided, overrides maxEpochs
}

export interface LoopResult {
  completed: boolean
  /** Last cumulative epoch number reached (not the count of sessions run this dispatch) */
  epochs: number
  sessionIds: string[]
  /** True when the loop exited because the process entered a scheduled sleep/waiting state */
  sleeping?: boolean
  /** True iff the loop ran all `maxEpochs` sessions without a COMPLETE signal, and without thrashing, auth failure, run() error, or sleep transition. This is a budget-boundary exit; the CLI exits 0 so the process is recorded as completed, not failed. */
  epochLimitReached?: boolean
  /** True when the loop exited because the wall-clock time limit (MAX_LOOP_DURATION_MS) was reached. The CLI exits 0 so the process is recorded as completed, not failed. */
  timeLimit?: boolean
}

/**
 * Parse markdown checkboxes from content.
 * Returns { checked, total } where total = checked + unchecked.
 */
export function parseCheckboxes(content: string): { checked: number; total: number } {
  const checkedMatches = content.match(/^- \[[xX]\]/gm) ?? []
  const uncheckedMatches = content.match(/^- \[ \]/gm) ?? []
  const checked = checkedMatches.length
  const total = checked + uncheckedMatches.length
  return { checked, total }
}

/**
 * Patch fields on the current process record (best-effort, never throws).
 */
async function patchProcess(fields: Record<string, unknown>): Promise<void> {
  const processId = process.env.EVAL_PROCESS_ID || process.env.EVAL_CAMPAIGN_ID
  if (!processId) return

  const supabaseUrl = getSupabaseUrl()
  // patchProcess is best-effort (see function comment). If the service key is
  // unset we silently skip; getSupabaseServiceKey() throws, so we catch to
  // preserve the existing opt-in behavior.
  let supabaseKey: string
  try {
    supabaseKey = getSupabaseServiceKey()
  } catch {
    return
  }

  try {
    // agent-interceptor patches globalThis.fetch to inject auth credentials; use the
    // original fetch here to avoid double-injecting tokens on direct Supabase calls.
    const nativeFetch = (globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch
    const res = await nativeFetch(`${supabaseUrl}/rest/v1/processes?id=eq.${encodeURIComponent(processId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(fields),
    })
    if (!res.ok) {
      console.warn(`[loop] patchProcess HTTP ${res.status}: ${res.statusText}`)
    }
  } catch (err) {
    console.warn(`[loop] patchProcess failed: ${(err as Error).message}`)
  }
}

/**
 * Update the progress field in the DB for the current process (best-effort, never throws).
 */
export async function updateProgress(workspaceDir: string): Promise<void> {
  const adapter = new StoryProgressAdapter()
  const progress = adapter.calculateProgress(workspaceDir)
  if (progress === null) return
  await patchProcess({ progress })
}

/**
 * Mark the current process as 'completed' in the DB (best-effort, never throws).
 * Called when the COMPLETE signal is detected in progress.md.
 */
export async function markProcessCompleted(): Promise<void> {
  await patchProcess({ status: 'completed', completed_at: new Date().toISOString() })
}

/**
 * Returns true if progress.md contains a COMPLETE signal anywhere in the file.
 * Accepts bare COMPLETE, *COMPLETE*, or **COMPLETE** anchored to a line boundary,
 * preventing false positives from substrings like INCOMPLETE or UNCOMPLETED.
 * Trailing content on the same line is allowed (e.g. "**COMPLETE** — all stories passed").
 */
function isCompleteSignal(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  const progress = readFileSync(filePath, 'utf-8')
  return /^(\*{0,2})COMPLETE\1(\s|$)/m.test(progress)
}

/**
 * Check if the current process is in 'waiting' state (e.g. scheduled sleep).
 * FAIL OPEN: any error returns false so the loop continues uninterrupted.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function checkWaitingStatus(): Promise<boolean> {
  const processId = process.env.EVAL_PROCESS_ID || process.env.EVAL_CAMPAIGN_ID
  if (!processId) return false
  if (!UUID_RE.test(processId)) return false

  try {
    const [bin, prefixArgs] = getCliCommand()
    const output = execFileSync(
      bin, [...prefixArgs, 'process', 'status', '--id', processId, '--json'],
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const parsed = JSON.parse(output.trim())
    if (parsed.status === 'waiting') {
      console.log(`Process is waiting until ${parsed.resumeAt ?? 'unknown'}`)
      return true
    }
    return false
  } catch (err) {
    console.warn(`Warning: could not check process waiting status: ${(err as Error).message}`)
    return false
  }
}

/**
 * Enrich process.env with process metadata from DB.
 * The SDK adapter reads EVAL_PROCESS and EVAL_SKILL_RESOURCE_ID from process.env
 * to build event emission context. These may not be set if the loop was launched
 * via a minimal tmux script that only exports EVAL_PROCESS_ID.
 */
function enrichProcessEnv(): void {
  const processId = process.env.EVAL_PROCESS_ID || process.env.EVAL_CAMPAIGN_ID
  if (!processId) return
  if (!UUID_RE.test(processId)) return

  try {
    const [bin, prefixArgs] = getCliCommand()
    const output = execFileSync(
      bin, [...prefixArgs, 'process', 'status', '--id', processId, '--json'],
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const parsed = JSON.parse(output.trim())

    // Set EVAL_PROCESS if not already set
    if (!process.env.EVAL_PROCESS && !process.env.EVAL_CAMPAIGN && parsed.name) {
      process.env.EVAL_PROCESS = parsed.name
      console.log(`Set EVAL_PROCESS=${parsed.name} from DB`)
    }

    // Set EVAL_SKILL_RESOURCE_ID if not already set and not null in DB
    if (!process.env.EVAL_SKILL_RESOURCE_ID && parsed.skillResourceId) {
      process.env.EVAL_SKILL_RESOURCE_ID = parsed.skillResourceId
      console.log(`Set EVAL_SKILL_RESOURCE_ID=${parsed.skillResourceId} from DB`)
    }
  } catch (err) {
    console.warn(`Warning: could not enrich process env: ${(err as Error).message}`)
  }
}

/**
 * Execute the ralph loop - an iterative optimization process using CLI adapter.
 */
export async function executeLoop(config: LoopConfig): Promise<LoopResult> {
  const { goal, testSetPath } = config
  const maxEpochs = config.epochs ?? config.maxEpochs
  const enableGit = config.git !== false   // default true
  const enablePR = config.pr === true
  const workspace = config.workspaceDir ?? './workspace'
  const worktreePath = resolve(workspace, '..')
  const promptsDir = resolve(workspace, 'prompts')
  const progressFile = resolve(workspace, 'progress.md')
  const stateFile = resolve(workspace, 'state.json')
  const sessionsFile = resolve(workspace, 'sessions.txt')

  // Validate testSetPath if provided
  if (testSetPath && !existsSync(testSetPath)) {
    console.warn(`Warning: testSetPath does not exist: ${testSetPath}`)
  }

  // Initialize workspace
  mkdirSync(promptsDir, { recursive: true })

  // Enrich env with process metadata from DB (EVAL_PROCESS, EVAL_SKILL_RESOURCE_ID)
  enrichProcessEnv()

  const eventService = createEventService()

  // Start watchdog — monitors for silence > 15 min and emits PROCESS_STALE.
  // Must live in the loop process (the long-lived tmux session) not in dispatch.ts
  // which exits immediately after launching the session.
  const processIdForWatchdog = process.env.EVAL_PROCESS_ID || process.env.EVAL_CAMPAIGN_ID
  const watchdog = processIdForWatchdog ? createWatchdog(processIdForWatchdog) : null

  try {

  if (!existsSync(progressFile)) {
    writeFileSync(progressFile, `# Progress Log\n\n**Goal**: ${goal}\n**Started**: ${new Date().toISOString()}\n\n---\n`)
  }

  // Read state.json to determine starting epoch (continue from last epoch + 1)
  let startEpoch = 1
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
      if (typeof state.epoch === 'number' && Number.isInteger(state.epoch) && state.epoch > 0) {
        startEpoch = state.epoch + 1
        console.log(`Resuming from state.json: last completed epoch ${state.epoch}, starting at epoch ${startEpoch}`)
      } else if (state.epoch !== undefined) {
        console.warn(`Warning: state.json has invalid epoch value: ${state.epoch}, starting from epoch 1`)
      }
    } catch {
      console.warn('Warning: state.json exists but could not be parsed, starting from epoch 1')
    }
  } else {
    console.log('No state.json yet - agent will create on first epoch')
  }
  const endEpoch = startEpoch + maxEpochs - 1

  const sessionIds: string[] = []
  let lastStateHash = ''
  let noProgressCount = 0
  const startTime = Date.now()
  const maxDuration = MAX_LOOP_DURATION_MS - DURATION_BUFFER_MS

  console.log('Starting Ralph Loop')
  console.log(`Goal: ${goal.substring(0, 100)}${goal.length > 100 ? '...' : ''}`)
  console.log(`Epochs: ${startEpoch} to ${endEpoch} (${maxEpochs} sessions)`)
  console.log(`Max duration: ${(maxDuration / 1000 / 60 / 60).toFixed(2)} hours (with ${DURATION_BUFFER_MS / 1000 / 60}min buffer)`)
  console.log(`Test set: ${testSetPath ?? '(agent will generate)'}`)
  console.log('')

  eventService?.emit({ source: EventType.PROCESS_START, payload: { epoch_start: startEpoch }, resource_id: null })
  const processId = process.env.EVAL_PROCESS_ID || process.env.EVAL_CAMPAIGN_ID
  if (processId && UUID_RE.test(processId)) {
    try {
      const [bin, prefixArgs] = getCliCommand()
      execFileSync(bin, [...prefixArgs, 'process', 'active', '--id', processId], { stdio: 'pipe', timeout: 15000 })
    } catch (err) {
      console.warn(`[loop] process active failed: ${(err as Error).message}`)
    }
  }

  for (let i = startEpoch; i <= endEpoch; i++) {
    // Check elapsed time before starting new epoch
    const elapsed = Date.now() - startTime
    if (elapsed >= maxDuration) {
      const elapsedHours = (elapsed / 1000 / 60 / 60).toFixed(2)
      console.log(`\nTime limit reached (${elapsedHours} hours). Stopping gracefully.`)
      console.log('State has been preserved - run can be continued from saved state.')
      eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: false, final_epoch: i - 1 }, resource_id: null })
      return { completed: false, epochs: i - 1, sessionIds, timeLimit: true }
    }

    // Check if process has entered waiting state (e.g. scheduled sleep)
    if (await checkWaitingStatus()) {
      console.log('Process sleeping — exiting loop cleanly')
      eventService?.emit({ source: EventType.PROCESS_SLEEP, payload: { epoch: i - 1 }, resource_id: null })
      eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: false, final_epoch: i - 1 }, resource_id: null })
      return { completed: false, epochs: i - 1, sessionIds, sleeping: true }
    }

    const sessionsRun = i - startEpoch
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  Epoch ${i} (session ${sessionsRun + 1} of ${maxEpochs})`)
    console.log(`  Elapsed: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`)
    console.log(`${'='.repeat(60)}\n`)

    // Check for completion signal at start of epoch (detects pre-existing COMPLETE)
    if (isCompleteSignal(progressFile)) {
      console.log('COMPLETE signal found in progress.md')
      await markProcessCompleted()
      eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: true, final_epoch: i }, resource_id: null })
      return { completed: true, epochs: i, sessionIds }
    }

    // Build prompt (ralph-specific composition)
    const prompt = buildRalphPrompt({ goal, epoch: i, maxEpochs: endEpoch, testSetPath, workingDir: worktreePath })

    // Save prompt for audit trail (ensure prompts dir exists in case an agent cleaned workspace)
    mkdirSync(promptsDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const promptFile = resolve(promptsDir, `epoch-${i}-${timestamp}.md`)
    writeFileSync(promptFile, prompt)
    console.log(`Prompt saved to: ${promptFile}`)

    // Execute via run() which syncs skills and handles CLI adapter
    let result
    try {
      result = await run({ prompt })
    } catch (err) {
      console.error(`Error in epoch ${i}: ${(err as Error).message}`)
      // Record partial progress before failing
      const errorLogFile = resolve(workspace, `epoch-${i}-error.log`)
      writeFileSync(errorLogFile, `Error: ${(err as Error).message}\n${(err as Error).stack ?? ''}`)
      eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: false, final_epoch: i }, resource_id: null })
      return { completed: false, epochs: i, sessionIds }
    }

    // Record session ID (with null check)
    const sessionId = result.execution.output.sessionId

    // Detect auth failure early — Claude exits immediately with "Not logged in"
    // or "Invalid API key" when auth is broken. In either case parseOutput
    // returns a fake sessionId of the form 'claude-{timestamp}' or 'error-{timestamp}'.
    // Abort immediately rather than burning all remaining epochs on a dead auth state.
    const rawOut = result.execution.output.rawOutput ?? ''
    const fakeSessionId = !sessionId || sessionId.startsWith('claude-') || sessionId.startsWith('error-')
    const errorField = result.execution.output.error ?? ''
    const authError = rawOut.includes('Not logged in') || rawOut.includes('Please run /login') || rawOut.includes('Invalid API key') || rawOut.includes('Fix external API key') || errorField.includes('auth_unavailable') || errorField.includes('OAuth token has expired')
    if (fakeSessionId || authError) {
      const hint = authError
        ? `Auth error: ${rawOut.slice(0, 120)}`
        : 'Claude produced no output (likely auth failure)'
      console.error(`ERROR: ${hint}`)
      console.error('Fix: ensure ANTHROPIC_API_KEY is set to a valid Anthropic API key (sk-ant-api03-...), not an OAuth token.')
      eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: false, final_epoch: i }, resource_id: null })
      return { completed: false, epochs: i, sessionIds }
    }
    if (sessionId) {
      sessionIds.push(sessionId)
      console.log(`Session ID: ${sessionId}`)
      // Append to sessions file
      writeFileSync(sessionsFile, `${sessionId}\n`, { flag: 'a' })
    } else {
      console.warn(`Warning: No session ID returned for epoch ${i}`)
    }

    // Write epoch log
    const logFile = resolve(workspace, `epoch-${i}.log`)
    writeFileSync(logFile, result.execution.output.rawOutput ?? '')

    // Collect execution metadata to persist alongside the epoch result
    const epochMeta: EpochMeta = {
      ...(sessionId ? { sessionId } : {}),
      ...(typeof result.execution.output.cost === 'number' ? { cost: result.execution.output.cost } : {}),
      ...(typeof result.execution.durationMs === 'number' ? { durationMs: result.execution.durationMs } : {}),
    }

    // Check for completion signal AFTER agent runs
    if (isCompleteSignal(progressFile)) {
      console.log('COMPLETE signal found in progress.md')
      if (enableGit) commitEpoch(i, workspace, epochMeta)
      await updateProgress(workspace)
      eventService?.emit({ source: EventType.EPOCH_END, payload: { epoch: i, progress: 'updated' }, resource_id: null })
      await markProcessCompleted()
      if (enablePR && process.env.EVAL_BRANCH) {
        try {
          openPRAdapter({ branch: process.env.EVAL_BRANCH, worktreePath })
        } catch (err) {
          console.error(`openPRAdapter failed: ${(err as Error).message}`)
        }
      }
      eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: true, final_epoch: i }, resource_id: null })
      return { completed: true, epochs: i, sessionIds }
    }

    // Defense-in-depth: if all PRD stories have passes=true, write COMPLETE automatically
    if (checkAllStoriesPassed(workspace)) {
      console.log('[loop] All PRD stories have passes=true — writing COMPLETE signal (defense-in-depth)')
      appendFileSync(progressFile, '\n**COMPLETE** — all stories passed (loop auto-detection)\n')
      if (enableGit) commitEpoch(i, workspace, epochMeta)
      await updateProgress(workspace)
      eventService?.emit({ source: EventType.EPOCH_END, payload: { epoch: i, progress: 'updated' }, resource_id: null })
      await markProcessCompleted()
      if (enablePR && process.env.EVAL_BRANCH) {
        try { openPRAdapter({ branch: process.env.EVAL_BRANCH, worktreePath }) } catch (err) { console.error(`openPRAdapter failed: ${(err as Error).message}`) }
      }
      eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: true, final_epoch: i }, resource_id: null })
      return { completed: true, epochs: i, sessionIds }
    }

    // Check for thrashing (no state.json changes)
    const currentStateHash = hashFile(stateFile)
    if (currentStateHash === lastStateHash) {
      noProgressCount++
      console.warn(`Warning: No state.json changes this epoch (${noProgressCount} consecutive)`)
      if (noProgressCount >= THRASHING_THRESHOLD) {
        console.error(`ERROR: ${THRASHING_THRESHOLD} epochs with no progress. Possible thrashing. Aborting.`)
        eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: false, final_epoch: i }, resource_id: null })
        return { completed: false, epochs: i, sessionIds }
      }
    } else {
      noProgressCount = 0
    }
    lastStateHash = currentStateHash

    if (enableGit) commitEpoch(i, workspace, epochMeta)
    await updateProgress(workspace)
    eventService?.emit({ source: EventType.EPOCH_END, payload: { epoch: i, progress: 'updated' }, resource_id: null })

    // Check if process entered waiting state after epoch completed
    if (await checkWaitingStatus()) {
      console.log('Process sleeping — exiting loop cleanly')
      eventService?.emit({ source: EventType.PROCESS_SLEEP, payload: { epoch: i }, resource_id: null })
      eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: false, final_epoch: i }, resource_id: null })
      return { completed: false, epochs: i, sessionIds, sleeping: true }
    }

    console.log(`Epoch ${i} complete.`)
  }

  console.log(`\nReached max sessions (${maxEpochs}) without completion. Last epoch: ${endEpoch}`)
  eventService?.emit({ source: EventType.PROCESS_END, payload: { completed: false, final_epoch: endEpoch }, resource_id: null })
  return { completed: false, epochs: endEpoch, sessionIds, epochLimitReached: true }

  } finally {
    watchdog?.stop()
  }
}

/**
 * Build the ralph prompt using unified SYSTEM.md + goal + test set info.
 */
export function buildRalphPrompt(opts: {
  goal: string
  epoch: number
  maxEpochs: number
  testSetPath?: string
  workingDir?: string
}): string {
  const systemPath = resolve(__dirname, 'SYSTEM.md')
  const systemTemplate = readFileSync(systemPath, 'utf-8')

  // Replace template variables
  const tracesPath = process.env.HOME ? `${process.env.HOME}/.claude/projects` : '~/.claude/projects'
  const cwd = opts.workingDir ?? process.env.WORKTREE_PATH ?? process.cwd()
  const system = systemTemplate
    .replace(/\$EPOCH/g, String(opts.epoch))
    .replace(/\$MAX_EPOCHS/g, String(opts.maxEpochs))
    .replace(/\$TRACES_PATH/g, tracesPath)
    .replace(/\$WORKING_DIR/g, cwd)

  const testSetSection = opts.testSetPath
    ? `## Test Set

Use this test set for validation: ${opts.testSetPath}

If this is a file path, read it. If it's a URL, fetch it.`
    : `## Test Set

No test set provided. You MUST generate your own test set before optimization:
1. Create representative test cases that cover edge cases
2. Save to workspace/test-set/
3. Use these consistently across all epochs`

  return `${system}

---

# Your Goal

${opts.goal}

${testSetSection}`
}

/**
 * Commit workspace and results to the eval branch after each epoch,
 * then upload this epoch's results to the database via agent-core process record.
 * Only runs when EVAL_BRANCH is set.
 * Handles HEAD recovery in case the agent corrupted git state during its session.
 * The GHA "Upload epoch results" step runs again at the end as an idempotent safety net.
 */

interface EpochMeta {
  sessionId?: string
  cost?: number
  durationMs?: number
}

function commitEpoch(epoch: number, workspace: string, meta?: EpochMeta): void {
  const branch = process.env.EVAL_BRANCH
  if (!branch) return
  if (!SAFE_BRANCH_RE.test(branch)) {
    console.error(`⚠️ commitEpoch skipped: EVAL_BRANCH contains unsafe characters: ${branch}`)
    return
  }
  if (!workspace || workspace.includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(workspace)) {
    console.error(`⚠️ commitEpoch skipped: workspace path looks suspicious: ${workspace}`)
    return
  }

  console.log('[commitEpoch]', { epoch, branch })
  try {
    appendFileSync(resolve(workspace, 'commit-epoch.log'), `${new Date().toISOString()} epoch=${epoch} branch=${branch}\n`)
  } catch (err) {
    console.warn('[commitEpoch] failed to write log:', err)
  }

  console.log(`\nCommitting epoch ${epoch} to ${branch}...`)

  const GIT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes — prevents indefinite hang on dead TCP connections

  const sh = (cmd: string, timeoutMs?: number): boolean => {
    try {
      execSync(cmd, { stdio: 'pipe', timeout: timeoutMs })
      return true
    } catch (err) {
      console.warn(`[commitEpoch] sh failed: ${cmd}`, (err as Error).message)
      return false
    }
  }

  const saveDir = `/tmp/epoch-ws-${epoch}-${process.pid}`
  try {
    // Save workspace and results before touching HEAD — the agent may have moved it
    execSync(`mkdir -p "${saveDir}"`)
    execSync(`cp -a "${workspace}" "${saveDir}/"`)
    if (existsSync('./results')) execSync(`cp -a ./results "${saveDir}/"`)

    // Recover HEAD by checking out the eval branch
    if (!sh(`git checkout -f "${branch}"`, GIT_TIMEOUT_MS)) {
      execSync(`git checkout -b "${branch}"`, { timeout: GIT_TIMEOUT_MS })
    }

    // Restore the agent's actual workspace (not the stale version from the branch)
    execSync(`cp -a "${saveDir}/workspace" .`)
    if (existsSync(`${saveDir}/results`)) execSync(`cp -a "${saveDir}/results" .`)

    // Clean up nested .git dirs that agents sometimes create (GitHub rejects them)
    sh(`find workspace -name ".git" -type d -exec rm -rf {} + 2>/dev/null`)
    if (existsSync('./results')) sh(`find results -name ".git" -type d -exec rm -rf {} + 2>/dev/null`)

    // Stage and commit if there are changes
    sh(`git add -f workspace/`)
    if (existsSync('./results')) sh(`git add -f results/`)

    if (!sh('git diff --cached --quiet')) {
      execSync(`git commit -m "Epoch ${epoch}"`, { stdio: 'inherit', timeout: GIT_TIMEOUT_MS })
      const sha = execSync('git rev-parse --short HEAD').toString().trim()
      console.log(`✅ Epoch ${epoch} committed: ${sha}`)
    } else {
      console.log(`ℹ️ No changes to commit for epoch ${epoch}`)
    }

    // Push branch so work is preserved even if the worktree is cleaned up
    if (sh(`git push --force-with-lease origin "${branch}" 2>/dev/null || git push origin "${branch}"`, GIT_TIMEOUT_MS)) {
      console.log(`✅ Epoch ${epoch} pushed to origin/${branch}`)
    } else {
      console.warn(`⚠️ Push failed for epoch ${epoch} — commits remain local`)
    }

    // Upload this epoch's results to the database immediately after commit.
    if (process.env.EVAL_CAMPAIGN_ID) console.warn('⚠️  EVAL_CAMPAIGN_ID is deprecated — use EVAL_PROCESS_ID')
    if (process.env.EVAL_CAMPAIGN) console.warn('⚠️  EVAL_CAMPAIGN is deprecated — use EVAL_PROCESS')
    const processId = process.env.EVAL_PROCESS_ID || process.env.EVAL_CAMPAIGN_ID
    const processName = process.env.EVAL_PROCESS || process.env.EVAL_CAMPAIGN
    if (processId || processName) {
      console.log(`\nUploading epoch ${epoch} results to database...`)
      try {
        const [bin, prefixArgs] = getCliCommand()
        execFileSync(
          bin,
          [
            ...prefixArgs, 'process', 'record',
            ...(processId ? ['--id', processId] : ['--name', processName!]),
            '--workspace', workspace,
            '--epoch', String(epoch),
            ...(meta?.sessionId ? ['--session-id', meta.sessionId] : []),
            ...(meta?.cost !== undefined ? ['--cost', String(meta.cost)] : []),
            ...(meta?.durationMs !== undefined ? ['--duration-ms', String(meta.durationMs)] : []),
          ],
          { stdio: 'inherit' }
        )
      } catch (err) {
        console.warn(`⚠️ duoidal process record failed for epoch ${epoch} — results remain in git:`, (err as Error).message)
      }
    }
  } catch (e) {
    console.error(`⚠️ commitEpoch failed: ${(e as Error).message}`)
  } finally {
    sh(`rm -rf "${saveDir}"`)
  }
}

function hashFile(filePath: string): string {
  if (!existsSync(filePath)) return 'none'
  const content = readFileSync(filePath)
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Returns true ONLY if workspace/state.json has an active_prd field pointing to a PRD file
 * where every story has passes: true (and the stories array is non-empty).
 * Returns false on ANY error — never throws.
 */
export function checkAllStoriesPassed(workspace: string): boolean {
  try {
    const stateFile = resolve(workspace, 'state.json')
    if (!existsSync(stateFile)) return false
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    const activePrd: unknown = state?.active_prd
    if (!activePrd || typeof activePrd !== 'string') return false
    if (!/^[\w-]+$/.test(activePrd)) return false
    const prdFile = resolve(workspace, `${activePrd}.json`)
    if (!existsSync(prdFile)) return false
    const prd = JSON.parse(readFileSync(prdFile, 'utf-8'))
    const stories: unknown = prd?.stories
    if (!Array.isArray(stories) || stories.length === 0) return false
    return stories.every((s: unknown) => typeof s === 'object' && s !== null && (s as Record<string, unknown>).passes === true)
  } catch (err) {
    console.warn(`[loop] checkAllStoriesPassed: failed to evaluate — ${(err as Error).message}`)
    return false
  }
}

// CLI entrypoint for testing
async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Ralph Loop CLI

Usage:
  npx tsx utils/loop/index.ts "<goal>" [options]

Options:
  --max-epochs N    Maximum loop epochs (default: 10)
  --test-set PATH   Path to test set file/folder
  --goal-file FILE  Read goal from a file instead of positional argument
  --pr              Open a PR after the loop completes

Example:
  npx tsx utils/loop/index.ts "Build HTML to PPTX converter" --max-epochs 5
`)
    process.exit(0)
  }

  let goal = ''
  let maxEpochs = 10
  let testSetPath: string | undefined
  let pr = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-epochs') {
      maxEpochs = parseInt(args[++i], 10)
    } else if (args[i] === '--test-set') {
      testSetPath = args[++i]
    } else if (args[i] === '--goal-file') {
      goal = readFileSync(args[++i], 'utf-8').trim()
    } else if (args[i] === '--pr') {
      pr = true
    } else if (!goal) {
      goal = args[i]
    }
  }

  if (!goal) {
    console.error('Goal is required')
    process.exit(1)
  }

  // Hard assertions: fail fast if critical env vars are missing.
  // Each has a bypass override (SKIP_*_CHECK=1) for local dev/testing.
  // Production dispatches never set the override.
  const envAssertions: Array<{ key: string; skip: string; why: string }> = [
    {
      key: 'EVAL_PROCESS_ID',
      skip: 'SKIP_PROCESS_ID_CHECK',
      why: 'Every DB operation, event, and lifecycle transition keys off this',
    },
    {
      key: 'DATABASE_URL',
      skip: 'SKIP_DATABASE_CHECK',
      why: 'Every agent-core CLI call and direct DB query fails without it',
    },
    {
      key: 'EVAL_BRANCH',
      skip: 'SKIP_BRANCH_CHECK',
      why: 'Without it, commitEpoch silently skips — epoch results never land in DB (silent data loss)',
    },
    {
      key: 'SUPABASE_URL',
      skip: 'SKIP_SUPABASE_CHECK',
      why: 'Without it, event emission and watchdog are no-ops — process runs blind with zero observability',
    },
  ]
  for (const { key, skip, why } of envAssertions) {
    if (!process.env[key]) {
      if (process.env[skip]) {
        console.warn(`WARNING: ${key} is not set but ${skip}=1 bypass is active. ${why}.`)
        continue
      }
      console.error(`ERROR: Required env var ${key} is not set. ${why}. Set ${key} before running, or bypass with ${skip}=1 for local dev/testing.`)
      process.exit(1)
    }
  }

  const result = await executeLoop({ goal, maxEpochs, testSetPath, pr })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.completed || result.sleeping || result.epochLimitReached || result.timeLimit ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Error:', err)
    process.exit(1)
  })
}
