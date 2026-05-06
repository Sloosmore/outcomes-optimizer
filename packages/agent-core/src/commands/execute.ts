import { Command } from 'commander'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { getAdapter } from '../lib/adapter-factory.js'
import { getLocalSubUnchecked } from '../lib/identity.js'
import { parseFrontmatter } from '../lib/frontmatter.js'
import { goalUpload } from '../lib/goal-upload.js'
import { goalLink } from '../lib/goal-link.js'
import { projectResolve } from '../lib/project-resolve.js'
import { readDispatchConfig, type DispatchConfig } from '../lib/dispatch-config.js'
import { routeToServer } from '../lib/waypoint-router.js'
import { pruneStaleDispatchArtifacts } from '../lib/dispatch-prune.js'
import { resolveDispatchBundle } from '../lib/dispatch-bundle.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

/**
 * Verifies a tmux session is still alive after launch.
 *
 * `tmux new-session -d` returns 0 the moment the detached shell is spawned,
 * regardless of whether the inner command crashes microseconds later. Without
 * this check, a dispatch whose inner `node dispatch.prebuilt.mjs ...` fails on import
 * (stale build, missing dep, syntax error) prints the success banner and exits
 * 0 — leaving zero process rows, zero worktrees, and no error reaching the
 * operator.
 *
 * Single sample at 500ms. Healthy dispatches do non-trivial work (git worktree
 * add + provision.ts subprocess + composeProvisioner up — all dominated by
 * Node cold-start and compose, totalling well over 500ms even when fully
 * cached). Crashes from import-time errors die under 400ms. So a tmux session
 * that has already ended by 500ms is an honest signal of "the inner crashed
 * before doing any work." (Reduced from 750ms in epoch 5 — saves 250ms per
 * dispatch. The 100ms margin above the crash threshold holds because compose
 * startup alone takes well over 100ms even when fully cached.)
 */
function assertTmuxSessionAlive(sessionName: string, innerLogPath?: string): void {
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  sleep(500)
  const probe = spawnSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' })
  if (probe.status !== 0) {
    let tail = ''
    if (innerLogPath) {
      try {
        const buf = fs.readFileSync(innerLogPath, 'utf-8')
        tail = buf.length > 4096 ? '...(truncated)...\n' + buf.slice(-4096) : buf
      } catch (e) {
        tail = `(could not read ${innerLogPath}: ${e instanceof Error ? e.message : String(e)})`
      }
    }
    const baseMsg =
      `dispatch inner command exited immediately for session '${sessionName}'. ` +
      `The CLI launched tmux but the inner 'node dispatch.prebuilt.mjs' crashed before doing any work. ` +
      `Common causes: stale @skill-networks/* dist build, missing dep, syntax error in repo HEAD, ` +
      `or missing dispatch.prebuilt.mjs.`
    const detail = innerLogPath
      ? `\n--- inner stdout/stderr (last 4KB of ${innerLogPath}) ---\n${tail || '(empty)'}\n--- end ---`
      : ''
    throw new Error(baseMsg + detail)
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// WORKTREE_REPO is interpolated into a tmux shell command string, so it must not
// contain shell metacharacters. Spaces, $, backticks, quotes, etc. are disallowed.
// WORKTREE_REPO must be a simple ASCII filesystem path with no special characters.
const SAFE_PATH_RE = /^[A-Za-z0-9/_.\-]+$/

/**
 * Resolves the local WORKTREE_REPO path.
 *
 * Priority:
 *   1. WORKTREE_REPO env var (explicit override — always wins)
 *   2. When config.server === 'self' (developer laptop), fall back to process.cwd()
 *      so `duoidal execute` works out-of-the-box from a checked-out repo.
 *   3. Otherwise '/root/dispatch' (openclaw/cloud runtime container path).
 *
 * The previous unconditional default of '/root/dispatch' broke local dispatch:
 * on a developer laptop that path does not exist, so `tmux -c /root/dispatch`
 * dies on cwd resolution and the session exits instantly.
 */
function resolveLocalWorktreeRepo(config: DispatchConfig): string {
  const explicit = process.env['WORKTREE_REPO']
  if (explicit) return explicit
  if (config.server === 'self') return process.cwd()
  return '/root/dispatch'
}

/**
 * Resolves the DISPATCH_BASE_DIR path — where provision.ts creates git worktrees
 * under <base-dir>/<slug>.
 *
 * Priority:
 *   1. DISPATCH_BASE_DIR env var (explicit override — always wins)
 *   2. When config.server === 'self' (developer laptop), fall back to
 *      ~/.duoidal/dispatch — persistent per-user scratch space.
 *   3. Otherwise '/root/dispatch' (cloud runtime container path, bind-mounted
 *      from the host so docker-in-docker bind mounts resolve consistently).
 *
 * The previous default of os.tmpdir()/duoidal-dispatch was wrong on two counts:
 * (a) agent state (worktrees, epoch artifacts, db snapshots) is not ephemeral
 * even when local — /tmp gets wiped on reboot and rotated by the OS, which
 * silently destroys in-progress work; and (b) inside the runtime container it
 * fails outright because the container's /tmp is invisible to the host Docker
 * daemon that actually performs compose bind mounts. The container sets
 * DISPATCH_BASE_DIR=/root/dispatch in docker-compose.yml to sidestep (b).
 */
function resolveDispatchBaseDir(config: DispatchConfig): string {
  // Resolution order: env var > config field > server-based default.
  // The config field exists for environments where neither default is the
  // bind-mounted path. The original failure: a runtime container with
  // server: self picks ~/.duoidal/dispatch, but only /root/dispatch is
  // bind-mounted from the outer host. Compose services then bind-mount an
  // inner-only path that the outer Docker daemon resolves to an empty
  // volume — pnpm install runs against a void, exits 0, the loop boots
  // with no node_modules, and the dispatched process hangs at pending.
  const explicit = process.env['DISPATCH_BASE_DIR']
  if (explicit) return explicit
  if (config.dispatch_base_dir) return config.dispatch_base_dir
  if (config.server === 'self') return path.join(os.homedir(), '.duoidal', 'dispatch')
  return '/root/dispatch'
}

export function executeCommand(): Command {
  const cmd = new Command('execute')
  cmd.description('Execute a goal by creating a skill resource and launching a tmux session')

  cmd.argument('[goal-path]', 'path to goal.md file')
  cmd.option('--goal <path>', 'path to goal.md (alternative to positional argument)')
  cmd.option('--epochs <n>', 'number of epochs')
  cmd.option('--slug <name>', 'override auto-generated slug')
  cmd.option('--agent <name>', 'agent or user name for the runs link (primary flag)')
  cmd.option('--assign-to <name>', 'agent or user name for the runs link (backward-compat alias for --agent)')
  cmd.option('--project-id <uuid>', 'explicit project ID')
  cmd.option('--sub <uuid>', 'explicit user sub (bypasses local token read)')
  cmd.option('--unlinked', 'explicit acknowledgment that no --assign-to is provided')
  cmd.option('--dry-run', 'print what would happen and exit before any DB writes or tmux spawn')
  cmd.option('--skill-resource-id <uuid>', 'skip upload/link and go directly to routing')
  cmd.option('--hops <n>', 'hop counter passed in by waypoint-router SSH invocation', '0')
  cmd.option('--no-pr', 'skip opening a pull request on loop completion')
  cmd.option('--pr', 'open a pull request on loop completion')
  cmd.option('--force', 'bypass the active-tmux safety check and prune stale dispatch artifacts regardless (use only when you know the prior run is truly dead)')

  cmd.action(async (goalPathArg: string | undefined, opts: {
    goal?: string
    epochs?: string
    slug?: string
    agent?: string
    assignTo?: string
    projectId?: string
    sub?: string
    unlinked?: boolean
    dryRun?: boolean
    skillResourceId?: string
    hops?: string
    pr?: boolean
    force?: boolean
  }) => {
    const hopCount = parseInt(opts.hops ?? '0', 10)
    if (!Number.isInteger(hopCount) || hopCount < 0) {
      console.log(`Error: --hops must be a non-negative integer, got: ${opts.hops}`)
      process.exitCode = 1
      return
    }

    // -------------------------------------------------------------------------
    // Path A: --skill-resource-id provided — skip upload/link, go directly to routing
    // -------------------------------------------------------------------------
    if (opts.skillResourceId) {
      const skillResourceId = opts.skillResourceId

      // Validate skill-resource-id is a proper UUID
      if (!UUID_RE.test(skillResourceId)) {
        console.log(`Error: --skill-resource-id must be a valid UUID, got: ${skillResourceId}`)
        process.exitCode = 1
        return
      }

      // Validate epochs
      const epochsRaw = opts.epochs ?? '10'
      const epochs = parseInt(epochsRaw, 10)
      if (!Number.isInteger(epochs) || epochs <= 0) {
        console.log(`Error: --epochs must be a positive integer, got: ${epochsRaw}`)
        process.exitCode = 1
        return
      }

      // Read config
      let config
      try {
        config = readDispatchConfig()
      } catch (err) {
        console.log(`Error: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
        return
      }

      // Dry-run for Path A
      if (opts.dryRun) {
        console.log('DRY RUN')
        console.log(`Skill Resource ID: ${skillResourceId}`)
        console.log(`Epochs: ${epochs}`)
        console.log(`Server: ${config.server}`)
        return
      }

      // Pre-resolve paths so the prune step has the same slug/worktree/base-dir
      // the tmux launch will use below. The prune needs these BEFORE routeToServer
      // because the 409 `experiments_name_unique` collision happens inside
      // init_process, which runs as soon as provisioning begins.
      const WORKTREE_REPO_A = resolveLocalWorktreeRepo(config)
      if (!SAFE_PATH_RE.test(WORKTREE_REPO_A)) {
        console.log(`Error: WORKTREE_REPO contains unsafe characters: ${WORKTREE_REPO_A}`)
        process.exitCode = 1
        return
      }
      const DISPATCH_BASE_DIR_A = resolveDispatchBaseDir(config)
      if (!SAFE_PATH_RE.test(DISPATCH_BASE_DIR_A)) {
        logger.error(`Error: DISPATCH_BASE_DIR contains unsafe characters: ${DISPATCH_BASE_DIR_A}`)
        process.exitCode = 1
        return
      }

      // Auto-prune stale artifacts from prior runs that shared this skill_resource_id.
      // This is guarded: if an active tmux session `dispatch-<slug>` is found on
      // the target, we refuse to prune and bail out with an actionable error so
      // we never clobber a live run. --force bypasses the safety check.
      const slugA = skillResourceId.slice(0, 8)
      try {
        await pruneStaleDispatchArtifacts({
          slug: slugA,
          worktreeRepo: WORKTREE_REPO_A,
          dispatchBaseDir: DISPATCH_BASE_DIR_A,
          skillResourceId,
          config,
        }, { force: opts.force })
      } catch (err) {
        // Safety-check abort — fail fast with the actionable message.
        // Use logger.error to avoid adding to the file's pre-existing no-console lint debt.
        logger.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
        return
      }

      // Route to server
      // Resolve pr up-front so it can be forwarded to remote dispatches as well
      // as used to format the local tmux command. The default mirrors commander's
      // negatable-flag semantics: opts.pr is `true` unless `--no-pr` was passed.
      const pr = opts.pr !== false
      try {
        const result = routeToServer(config, skillResourceId, epochs, { hopCount, unlinked: opts.unlinked, pr })
        if (result.local) {
          fs.mkdirSync(DISPATCH_BASE_DIR_A, { recursive: true })
          const sessionName = `dispatch-${skillResourceId}`
          // Resolve the pre-compiled dispatch bundle relative to THIS package,
          // not relative to WORKTREE_REPO. The bundle ships with the CLI; it
          // has nothing to do with the target repo the operator is sitting in.
          let DISPATCH_BUNDLE: string
          try {
            DISPATCH_BUNDLE = resolveDispatchBundle()
          } catch (err) {
            console.log(`Error: ${err instanceof Error ? err.message : String(err)}`)
            process.exitCode = 1
            return
          }
          const unlinkedFlag = opts.unlinked ? ' --unlinked' : ''
          const prFlag = pr ? ' --pr' : ' --no-pr'
          // Source the repo .env so dispatch bundle inherits sandbox-level vars
          const repoEnvPathA = path.join(WORKTREE_REPO_A, '.env')
          const sourceEnvA = fs.existsSync(repoEnvPathA) ? `set -a && . ${repoEnvPathA} && set +a && ` : ''
          // Export WORKTREE_REPO + DISPATCH_BASE_DIR so dispatch bundle and its callees
          // (provision bundle → worktreeProvisioner) use the same paths we resolved here.
          // Otherwise provision defaults the worktree base to /root/dispatch which
          // does not exist on a developer laptop.
          const envPrefixA = `WORKTREE_REPO=${WORKTREE_REPO_A} DISPATCH_BASE_DIR=${DISPATCH_BASE_DIR_A} `
          // Tee stdout+stderr of the inner command into a log file BEFORE tmux's
          // pty closes on crash. The redirect lives inside the shell command so
          // it is atomic with the inner process — `pipe-pane` would race the
          // immediate-crash case. The file lives under DISPATCH_BASE_DIR (not
          // /tmp) so it survives reboot alongside the worktree it documents.
          const innerLogA = path.join(DISPATCH_BASE_DIR_A, `${sessionName}.log`)
          const innerCmdA = `node ${DISPATCH_BUNDLE} --skill-resource-id ${skillResourceId} --epochs ${epochs}${unlinkedFlag}${prFlag}`
          execFileSync('tmux', [
            'new-session', '-d', '-s', sessionName,
            '-c', WORKTREE_REPO_A,
            `${sourceEnvA}${envPrefixA}{ ${innerCmdA} ; } > ${innerLogA} 2>&1`,
          ])
          assertTmuxSessionAlive(sessionName, innerLogA)
          console.log(`Launched tmux session: ${sessionName}`)
          console.log(`Inner log: ${innerLogA}`)
        }
        // If local is false, SSH hop handled it — do NOT launch tmux locally
      } catch (err) {
        console.log(`Error: execute failed — ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
        return
      }

      return
    }

    // -------------------------------------------------------------------------
    // Path B: file-path positional arg OR --goal <path> provided
    // -------------------------------------------------------------------------

    // 1. Resolve goal file path
    const goalPath = opts.goal ?? goalPathArg
    if (!goalPath) {
      logger.error('Error: no goal file specified. Provide a positional argument or --goal <path>')
      process.exitCode = 1
      return
    }

    const resolvedPath = path.resolve(goalPath)
    let goalContent: string
    try {
      goalContent = fs.readFileSync(resolvedPath, 'utf-8')
    } catch {
      logger.error(`Error: could not read goal file at ${resolvedPath}`)
      process.exitCode = 1
      return
    }

    // 2. Parse frontmatter
    const frontmatter = parseFrontmatter(goalContent)
    const frontmatterAssignment = frontmatter['assignment']
    const frontmatterEpochsRaw = frontmatter['epochs']

    // 3. Resolve sub
    const sub = opts.sub ?? getLocalSubUnchecked()
    if (!sub) {
      logger.error('Error: no user sub available')
      process.exitCode = 1
      return
    }

    // 4. Generate slug from goal content
    let slug: string
    if (opts.slug) {
      slug = opts.slug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
    } else {
      // Strip frontmatter block from content before slug extraction
      const frontmatterMatch = goalContent.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)
      const body = frontmatterMatch ? goalContent.slice(frontmatterMatch[0].length) : goalContent
      const lines = body.split('\n')
      const firstNonEmpty = lines.find(l => l.trim().length > 0) ?? ''
      let title = firstNonEmpty
      if (title.startsWith('# Goal:')) {
        title = title.slice('# Goal:'.length).trim()
      } else if (title.startsWith('# ')) {
        title = title.slice(2).trim()
      }
      slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
    }
    if (!slug) {
      logger.error('Error: could not derive a slug from goal content. Use --slug to set one explicitly.')
      process.exitCode = 1
      return
    }

    // 5. Resolve epochs — flag overrides frontmatter, default 10
    let epochs: number
    if (opts.epochs !== undefined) {
      epochs = parseInt(opts.epochs, 10)
    } else if (frontmatterEpochsRaw !== undefined) {
      epochs = parseInt(frontmatterEpochsRaw, 10)
    } else {
      epochs = 10
    }
    if (!Number.isInteger(epochs) || epochs <= 0) {
      const raw = opts.epochs ?? frontmatterEpochsRaw ?? '10'
      logger.error(`Error: --epochs must be a positive integer, got: ${raw}`)
      process.exitCode = 1
      return
    }

    // 6. Resolve project ID
    let projectId: string | undefined = opts.projectId
    if (!projectId) {
      if (opts.sub) {
        // --sub was explicitly provided — use adapter directly
        const adapter = getAdapter()
        const projects = await adapter.listProjectsForUser(sub)
        if (projects.length > 1) {
          logger.warn(`Warning: user has ${projects.length} projects, defaulting to "${projects[0].name}" (${projects[0].id}). Use --project-id to select explicitly.`)
        }
        if (projects.length > 0) {
          projectId = projects[0].id
        } else {
          logger.warn('Warning: no projects found for user, continuing without project ID')
        }
      } else {
        // Use projectResolve() which internally uses getLocalSubUnchecked
        const resolved = await projectResolve()
        if (resolved) {
          projectId = resolved
        } else {
          logger.warn('Warning: no projects found for user, continuing without project ID')
        }
      }
    }

    // 7. Read config (needed for default_link and routing)
    let config
    try {
      config = readDispatchConfig()
    } catch (err) {
      console.log(`Error: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
      return
    }

    // 8. Resolve assignment priority: --agent > --assign-to > frontmatter > config default_link
    let assignment: string | undefined = opts.agent ?? opts.assignTo ?? frontmatterAssignment
    if (!assignment && config.default_link) {
      assignment = config.default_link
    }

    // 9. If --dry-run (config is already read so assignment includes default_link)
    if (opts.dryRun) {
      console.log('DRY RUN')
      console.log(`Goal: ${resolvedPath}`)
      console.log(`Slug: ${slug}`)
      console.log(`Sub: ${sub}`)
      console.log(`Project ID: ${projectId ?? '(none)'}`)
      console.log(`Assign-to: ${assignment ?? '(none)'}`)
      console.log(`Epochs: ${epochs}`)
      return
    }

    // 10. Enforce assignment or --unlinked
    if (!assignment && !opts.unlinked) {
      logger.error('Error: no --agent provided. Pass --agent <name> to link this run to an agent, or --unlinked to explicitly acknowledge that no agent assignment is needed.')
      process.exitCode = 1
      return
    }

    // 11. Validate WORKTREE_REPO + DISPATCH_BASE_DIR before any shell interpolation
    // NOTE: we validate both here (before upload/link side-effects) so the path
    // check fails fast, but we only mkdir DISPATCH_BASE_DIR inside the local-tmux
    // branch below — creating /root/dispatch on a developer laptop would fail.
    const WORKTREE_REPO = resolveLocalWorktreeRepo(config)
    if (!SAFE_PATH_RE.test(WORKTREE_REPO)) {
      logger.error(`Error: WORKTREE_REPO contains unsafe characters: ${WORKTREE_REPO}`)
      process.exitCode = 1
      return
    }
    const DISPATCH_BASE_DIR = resolveDispatchBaseDir(config)
    if (!SAFE_PATH_RE.test(DISPATCH_BASE_DIR)) {
      logger.error(`Error: DISPATCH_BASE_DIR contains unsafe characters: ${DISPATCH_BASE_DIR}`)
      process.exitCode = 1
      return
    }

    // 12. Execute — upload, link, route (config already read in step 7)
    let skillResourceId: string | undefined
    const pr = opts.pr !== false

    try {
      // a. Upload skill resource (pass resolved epochs so resource metadata matches dispatch count,
      // and pass the resolved slug so --slug override is honored on the real path, matching dry-run).
      const uploadResult = await goalUpload(resolvedPath, epochs, slug, { pr })
      skillResourceId = uploadResult.skillResourceId
      if (!UUID_RE.test(skillResourceId)) {
        throw new Error(`adapter returned invalid resource ID: ${skillResourceId}`)
      }
      console.log(`Skill resource ID: ${skillResourceId}`)

      // b+c. Link skill to project and create runs link in parallel — both
      // depend on skillResourceId from step (a), but are independent of each other.
      // Parallel execution saves ~0.5s (one DB round-trip eliminated from the critical path).
      const linkPromises: Promise<unknown>[] = []
      if (projectId) {
        const adapter = getAdapter()
        linkPromises.push(adapter.createResourceLinkById(skillResourceId, projectId, 'parent'))
      }
      if (assignment) {
        linkPromises.push(goalLink(skillResourceId, assignment))
      }
      await Promise.all(linkPromises)
      if (assignment) {
        console.log(`Created runs link: ${assignment} → skill/${uploadResult.slug}`)
      }

      // d. Route to server
      const routeResult = routeToServer(config, skillResourceId, epochs, { hopCount, unlinked: opts.unlinked, pr })

      if (routeResult.local) {
        // Launch tmux locally — only now do we actually create the local
        // DISPATCH_BASE_DIR, since remote dispatch never touches this filesystem.
        fs.mkdirSync(DISPATCH_BASE_DIR, { recursive: true })
        const sessionName = `dispatch-${skillResourceId}`
        // Use the pre-compiled dispatch bundle (no tsx cold-start overhead)
        const DISPATCH_BUNDLE = path.join(WORKTREE_REPO, 'utils', 'dispatch', 'dispatch.prebuilt.mjs')
        const unlinkedFlag = assignment ? '' : ' --unlinked'
        // Source the repo .env so dispatch bundle inherits sandbox-level vars
        const repoEnvPathB = path.join(WORKTREE_REPO, '.env')
        const sourceEnvB = fs.existsSync(repoEnvPathB) ? `set -a && . ${repoEnvPathB} && set +a && ` : ''
        // Export WORKTREE_REPO + DISPATCH_BASE_DIR so dispatch bundle and its callees
        // (provision bundle → worktreeProvisioner) use the same paths we resolved here.
        // Otherwise provision defaults the worktree base to /root/dispatch which
        // does not exist on a developer laptop.
        const envPrefixB = `WORKTREE_REPO=${WORKTREE_REPO} DISPATCH_BASE_DIR=${DISPATCH_BASE_DIR} `
        const prFlag = pr ? ' --pr' : ' --no-pr'
        execFileSync('tmux', [
          'new-session', '-d', '-s', sessionName,
          '-c', WORKTREE_REPO,
          `${sourceEnvB}${envPrefixB}node ${DISPATCH_BUNDLE} --skill-resource-id ${skillResourceId} --epochs ${epochs}${unlinkedFlag}${prFlag}`,
        ])
        assertTmuxSessionAlive(sessionName)
        console.log(`Launched tmux session: ${sessionName}`)
      }
      // If local is false, SSH hop handled it — do NOT launch tmux locally
    } catch (err) {
      logger.error(`Error: execute failed — ${err instanceof Error ? err.message : String(err)}`)
      if (skillResourceId) {
        logger.error(`Partial state may exist. Created resource: ${skillResourceId}`)
        logger.error(`Inspect with: npx agent-core resource get --id ${skillResourceId}`)
      }
      process.exitCode = 1
      return
    }
  })

  return cmd
}
