/**
 * Tmux session launcher for dispatch loop workflows.
 *
 * Starts a loop in a tmux session with an optional context file prepended to the goal.
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { getCliBashPrefix } from '../../cli-prefix.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Launches a tmux session running the dispatch loop.
 * If contextFile is provided, its content is prepended to workspace/goal.md in the worktree.
 * Prints the tmux attach command after launch.
 */
export async function launch(opts: {
  slug: string
  worktreePath: string
  processId: string
  skillResourceId?: string
  contextFile?: string
  maxEpochs?: number
  pr?: boolean
  loopScript?: string
}): Promise<void> {
  const { slug, worktreePath, processId, skillResourceId, contextFile, maxEpochs, pr, loopScript } = opts

  if (!processId) {
    throw new Error('processId is required — pass --process-id or set EVAL_PROCESS_ID')
  }
  if (!UUID_RE.test(processId)) {
    throw new Error(`Invalid processId: expected UUID, got "${processId}"`)
  }
  if (skillResourceId && !UUID_RE.test(skillResourceId)) {
    throw new Error(`Invalid skillResourceId: expected UUID, got "${skillResourceId}"`)
  }

  if (contextFile) {
    const contextContent = fs.readFileSync(contextFile, 'utf8')
    const goalPath = path.join(worktreePath, 'workspace', 'goal.md')
    let goalContent = ''
    if (fs.existsSync(goalPath)) {
      goalContent = fs.readFileSync(goalPath, 'utf8')
    }
    fs.writeFileSync(goalPath, contextContent + goalContent, 'utf8')
  }

  if (maxEpochs !== undefined && (!Number.isInteger(maxEpochs) || maxEpochs <= 0)) {
    throw new Error('maxEpochs must be a positive integer')
  }

  const maxEpochsFlag = maxEpochs !== undefined ? ` --max-epochs ${maxEpochs}` : ''
  const prFlag = pr ? ' --pr' : ' --no-pr'

  // Shell-escape values that are interpolated into the tmux command string
  // (tmux passes the command to sh -c, so single-quote escaping is required)
  const shellEscape = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

  const escapedWorktree = shellEscape(worktreePath)
  const escapedSlug = shellEscape(slug)
  const escapedProcessId = shellEscape(processId)
  // NOTE: NODE_OPTIONS is an env var value, not a shell word — the path goes inside
  // a double-quoted string, so it must NOT be single-quoted. Use the raw path directly.
  const bootMjsPath = worktreePath + '/services/credential-proxy/interceptor-boot.mjs'

  // Resolve the real paths of TypeScript entry points so that import.meta.url matches
  // process.argv[1] even when the worktree uses symlinked utils/. Without this, the
  // `main()` guard in these files (`if (import.meta.url === 'file://${process.argv[1]}')`)
  // never fires and the scripts exit 0 silently.
  const resolveScript = (rel: string): string => {
    const p = path.join(worktreePath, rel)
    try { return fs.realpathSync(p) } catch { return p }
  }
  // Like resolveScript but resolves relative to the source repo root instead of the worktree.
  // Falls back to the raw path if realpathSync fails (e.g. in test environments where paths
  // don't exist on disk).
  const resolveSourceScript = (rel: string): string => {
    const p = path.resolve(sourceRepoRoot, rel)
    try { return fs.realpathSync(p) } catch { return p }
  }
  // Resolve source-repo root for finding pre-compiled bundles and teardown script.
  // WORKTREE_REPO is set by execute.ts in the dispatch session (always available in
  // normal dispatch flow). Falls back to import.meta.url when launch.ts is run directly
  // (dev/testing). This ensures paths are correct whether launch.ts is executed as
  // source (via tsx) or when it is bundled into dispatch.prebuilt.mjs (where
  // import.meta.url points to the dispatch bundle, not launch.ts's original directory).
  const sourceRepoRoot = process.env['WORKTREE_REPO']
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  // Resolve loop bundle from the SOURCE REPO rather than from the worktree. New worktrees
  // are provisioned from origin/main, which may not include the pre-compiled bundle
  // (it lives on the eval branch only). Using the source-repo path guarantees the bundle
  // is always found. Falls back to tsx if the bundle does not exist in the source repo.
  const sourceRepoLoopBundle = path.resolve(sourceRepoRoot, 'utils/loop/index.prebuilt.mjs')
  // True when no custom loopScript was passed AND the prebuilt bundle exists.
  // Controls whether to use `node` (bundle) or `npx tsx` (TypeScript source fallback).
  const usePrebuiltLoop = !loopScript && fs.existsSync(sourceRepoLoopBundle)
  const loopScriptPath = loopScript
    ? shellEscape(fs.realpathSync(loopScript))
    : shellEscape(
        usePrebuiltLoop
          ? fs.realpathSync(sourceRepoLoopBundle)
          : resolveScript('utils/loop/index.ts'),
      )
  const teardownPath = shellEscape(resolveScript('utils/dispatch/teardown.ts'))
  // Source repo teardown — used for the sleeping path because the child worktree
  // may not have node_modules (no pnpm install). The source repo always has node_modules.
  const sourceTeardownPath = shellEscape(resolveSourceScript('utils/dispatch/teardown.ts'))

  // Build a bash script with process lifecycle management:
  // [1] Pre-loop: mark process active via ProcessLifecycleAdapter
  // [2] Run the loop with pipefail so tee doesn't mask exit codes
  // [3] Post-loop: check DB status, then complete or fail accordingly
  const script = [
    `cd ${escapedWorktree}`,
    `export PATH=${escapedWorktree}/node_modules/.bin:$PATH`,
    `export EVAL_PROCESS_ID=${escapedProcessId}`,
    ...(skillResourceId ? [`export EVAL_SKILL_RESOURCE_ID=${shellEscape(skillResourceId)}`] : []),
    `export NODE_OPTIONS="--import ${bootMjsPath}"`,
    `export WORKTREE_PATH=${escapedWorktree}`,
    `export LOOP_CMD="${loopScript ? `npx tsx ${loopScriptPath}` : `${usePrebuiltLoop ? 'node' : 'npx tsx'} ${loopScriptPath} --goal-file workspace/goal.md${maxEpochsFlag}${prFlag}`}"`,
    ...(process.env.ANTHROPIC_BASE_URL ? [`export ANTHROPIC_BASE_URL=${shellEscape(process.env.ANTHROPIC_BASE_URL)}`] : []),
    ...(process.env.ANTHROPIC_API_KEY ? [`export ANTHROPIC_API_KEY=${shellEscape(process.env.ANTHROPIC_API_KEY)}`] : []),
    // EVAL_BRANCH is required for commitEpoch() to commit workspace state and upload epoch results
    // to the DB. Without it, current_epoch and metrics are never updated on the process record.
    // Derive from the worktree's current git branch.
    `export EVAL_BRANCH=$(git -C ${escapedWorktree} rev-parse --abbrev-ref HEAD 2>/dev/null || echo ${shellEscape('boot/' + slug)})`,
    `{ [ -n "$EVAL_BRANCH" ] && [ "$EVAL_BRANCH" != "HEAD" ]; } || export EVAL_BRANCH=${shellEscape('boot/' + slug)}`,
    // DATABASE_URL and DIRECT_URL are needed by agent-core CLI commands (process active/complete/fail)
    // inside the tmux session. They are not injected by the credential proxy (which handles HTTP only).
    // Fall back to SKILL_NETWORKS_DATABASE_URL if DATABASE_URL is not set (Doppler uses the former).
    ...((process.env.DATABASE_URL || process.env.SKILL_NETWORKS_DATABASE_URL) ? [`export DATABASE_URL=${shellEscape(process.env.DATABASE_URL || process.env.SKILL_NETWORKS_DATABASE_URL || '')}`] : []),
    // DIRECT_URL must be a non-pooled direct connection (used by Drizzle migrations). Do not fall
    // back to SKILL_NETWORKS_DATABASE_URL here because that URL may be a pooled PgBouncer endpoint,
    // which would break prepared-statement-based migrations.
    ...(process.env.DIRECT_URL ? [`export DIRECT_URL=${shellEscape(process.env.DIRECT_URL)}`] : []),
    `export SKILL_NETWORKS_CLI=${shellEscape(getCliBashPrefix())}`,
    ...(process.env.SUPABASE_URL ? [`export SUPABASE_URL=${shellEscape(process.env.SUPABASE_URL)}`] : []),
    ...(process.env.SUPABASE_SERVICE_KEY ? [`export SUPABASE_SERVICE_KEY=${shellEscape(process.env.SUPABASE_SERVICE_KEY)}`] : []),
    ...(process.env.PROVISION_OPTS_BUILD_LOCAL ? [`export PROVISION_OPTS_BUILD_LOCAL=${shellEscape(process.env.PROVISION_OPTS_BUILD_LOCAL)}`] : []),
    // Auth debug credentials — auto-login for dev/worktree runs so the loop agent
    // never hits a login wall. These are dev-only; production builds throw if set.
    ...(process.env.VITE_DEBUG_EMAIL ? [`export VITE_DEBUG_EMAIL=${shellEscape(process.env.VITE_DEBUG_EMAIL)}`] : []),
    ...(process.env.VITE_DEBUG_PASSWORD ? [`export VITE_DEBUG_PASSWORD=${shellEscape(process.env.VITE_DEBUG_PASSWORD)}`] : []),
    ``,
    // Run process active in background so the loop can start immediately.
    // The wait is done after the loop exits to ensure the status was set before
    // lifecycle transitions (complete/fail) run. Saves ~1.9s off first-event latency.
    `$SKILL_NETWORKS_CLI process active --id "$EVAL_PROCESS_ID" & ACTIVE_PID=$!`,
    ``,
    `set -o pipefail`,
    `trap 'rm -f workspace/.loop-pid' EXIT`,
    `( umask 077 && echo $$ > workspace/.loop-pid )`,
    ...(loopScript
      ? [
          `npx tsx ${loopScriptPath} \\`,
          `  2>&1 | tee run-loop.log`,
        ]
      : [
          `${usePrebuiltLoop ? 'node' : 'npx tsx'} ${loopScriptPath} --goal-file workspace/goal.md${maxEpochsFlag}${prFlag} \\`,
          `  2>&1 | tee run-loop.log`,
        ]),
    `LOOP_EXIT=\${PIPESTATUS[0]}`,
    ``,
    `LIFECYCLE_OK=true`,
    // Ensure process active completed before reading PROC_STATUS or running lifecycle transitions.
    // This normally finishes well before the loop (active takes ~1.9s, loop takes >3s to
    // emit first event). wait here guarantees ordering: PROC_STATUS always reflects the
    // post-active state so the blocked/waiting branches see the correct status.
    `wait $ACTIVE_PID || { echo "ERROR: could not mark process active — DB unreachable?" >&2; LIFECYCLE_OK=false; }`,
    ``,
    `PROC_STATUS=$($SKILL_NETWORKS_CLI process status --id "$EVAL_PROCESS_ID" --json 2>/dev/null \\`,
    `  | node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).status||'unknown')}catch{process.stdout.write('unknown')}" 2>/dev/null || echo "unknown")`,
    ``,
    `if [ -f "workspace/.sleeping" ] || [ "$PROC_STATUS" = "waiting" ]; then`,
    `  echo "Process sleeping — stopping infrastructure, preserving worktree"`,
    `  rm -f "workspace/.sleeping"`,
    `  npx tsx ${sourceTeardownPath} --slug ${escapedSlug} --worktree ${escapedWorktree} --provision compose \\`,
    `    || echo "WARNING: teardown failed (non-fatal)" >&2`,
    `  echo "Worktree preserved at: ${worktreePath}"`,
    `  exit 0`,
    `elif [ "$PROC_STATUS" = "blocked" ]; then`,
    `  echo "Process blocked — stopping infrastructure, preserving worktree"`,
    `  npx tsx ${sourceTeardownPath} --slug ${escapedSlug} --worktree ${escapedWorktree} --provision compose \\`,
    `    || echo "WARNING: teardown failed (non-fatal)" >&2`,
    `  echo "Worktree preserved at: ${worktreePath}"`,
    `  echo "To resume: resolve the blocker and run: $SKILL_NETWORKS_CLI process restart --id $EVAL_PROCESS_ID"`,
    `  exit 0`,
    `elif [ "$LOOP_EXIT" -eq 0 ]; then`,
    `  $SKILL_NETWORKS_CLI process complete --id "$EVAL_PROCESS_ID" \\`,
    `    || { echo "ERROR: could not mark process complete — DB unreachable?" >&2; LIFECYCLE_OK=false; }`,
    `else`,
    `  $SKILL_NETWORKS_CLI process fail --id "$EVAL_PROCESS_ID" \\`,
    `    --reason "loop exited with code $LOOP_EXIT" \\`,
    `    || { echo "ERROR: could not mark process failed — DB unreachable?" >&2; LIFECYCLE_OK=false; }`,
    `fi`,
    `npx tsx ${teardownPath} --slug ${escapedSlug} --worktree ${escapedWorktree} --provision compose --provision worktree || echo "WARNING: teardown failed (non-fatal)" >&2`,
    `[ "$LIFECYCLE_OK" = "true" ] || exit 1`,
  ].join('\n')

  // Pass 'bash' and '-c' as separate args so tmux spawns bash directly
  // (avoids sh which doesn't support PIPESTATUS)
  execFileSync('tmux', ['new-session', '-d', '-s', slug, 'bash', '-c', script], { stdio: 'inherit' })

  // Log this from the OUTER dispatch wrapper so an operator watching the wrapper
  // pane gets a clear "we made it past provision and the loop tmux is live" signal.
  // Without this, a healthy dispatch and a stuck-mid-provision dispatch were
  // visually indistinguishable until the loop printed its first event.
  console.log(`[dispatch] inner work tmux launched: ${slug} (attach: tmux attach -t ${slug})`)
}

const BOOLEAN_FLAGS = new Set(['pr', 'no-pr'])

export function parseLaunchArgs(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (BOOLEAN_FLAGS.has(key)) {
        // Boolean flag: consume no value, just set to true
        parsed[key] = true
      } else {
        const value = args[i + 1]
        if (value !== undefined && !value.startsWith('--')) {
          parsed[key] = value
          i++
        }
      }
    }
  }
  return parsed
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help')) {
    console.log(`Usage: launch.ts --slug <slug> --worktree <path> --process-id <id> [--context-file <path>] [--max-epochs <n>] [--loop-script <path>] [--pr]

Options:
  --slug          Unique slug for the tmux session name
  --worktree      Path to the git worktree directory
  --process-id    Process ID passed as EVAL_PROCESS_ID env var
  --context-file  Optional file whose content is prepended to workspace/goal.md
  --max-epochs    Optional max epochs limit for the loop
  --loop-script   Optional custom loop script path (overrides default utils/loop/index.ts, no --goal-file args)
  --pr            Boolean flag: pass --pr to the loop to open a pull request on completion
  --no-pr         Boolean flag: explicitly skip opening a pull request on completion

After launch, prints: tmux attach -t <slug>`)
    process.exit(0)
  }

  const parsed = parseLaunchArgs(args)

  const processId = (parsed['process-id'] as string | undefined) ?? process.env.EVAL_PROCESS_ID

  if (!parsed['slug'] || !parsed['worktree'] || !processId) {
    console.error('Error: --slug, --worktree, and --process-id (or EVAL_PROCESS_ID env) are required')
    process.exit(1)
  }

  await launch({
    slug: parsed['slug'] as string,
    worktreePath: parsed['worktree'] as string,
    processId,
    contextFile: parsed['context-file'] as string | undefined,
    maxEpochs: parsed['max-epochs'] !== undefined ? parseInt(parsed['max-epochs'] as string, 10) : undefined,
    loopScript: parsed['loop-script'] as string | undefined,
    pr: parsed['pr'] === true && parsed['no-pr'] !== true,
  })
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
