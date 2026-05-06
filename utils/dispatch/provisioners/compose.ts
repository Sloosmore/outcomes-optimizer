/**
 * Compose provisioner — runs unconditional pnpm install + build for every
 * dispatch worktree (hash-sentinel for idempotency), then optionally runs
 * `docker compose up -d --wait` when a compose.yml is present.
 *
 * Runs after the worktree provisioner so ctx.worktreePath is set.
 * Docker Compose steps no-op silently when no compose.yml is found, allowing
 * every dispatch to include --provision compose without overhead when unused.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { createHash } from 'node:crypto'
import type { Provisioner } from '../provisioner.js'
import type { ProvisionContext } from '../provision-context.js'
import { parseSharedEnv, discoverPorts } from './compose-env.js'

/**
 * Resolves the shared Turborepo cache directory used across dispatch worktrees.
 *
 * The default `node_modules/.cache/turbo` lives inside each worktree, so a
 * fresh worktree always cache-misses and rebuilds. Pointing every worktree at
 * one host-level directory turns cross-worktree builds into ~1s tarball
 * extractions when the input hash matches.
 *
 * `TURBO_CACHE_DIR` from the parent env wins when set (lets operators override
 * for local debugging or to share with CI).
 */
function resolveTurboCacheDir(): string {
  return process.env['TURBO_CACHE_DIR'] || path.join(os.homedir(), '.cache', 'turbo-shared')
}

/**
 * Resolves compose.yml path within the worktree.
 * Checks <worktreePath>/compose.yml then <worktreePath>/.duoidal/compose.yml.
 * Returns the path if found, undefined otherwise.
 */
function findComposePath(worktreePath: string): string | undefined {
  const candidates = [
    path.join(worktreePath, 'compose.yml'),
    path.join(worktreePath, '.duoidal', 'compose.yml'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Returns true if `docker compose version` exits successfully.
 */
function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['compose', 'version'], {
    stdio: 'pipe',
    timeout: 10_000,
  })
  return result.status === 0
}

/**
 * Derives a Docker Compose-safe project name from a worktree path.
 * Docker requires lowercase alphanumeric, hyphens, and underscores only.
 */
function projectNameFor(worktreePath: string): string {
  return `wt-${path.basename(worktreePath).toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
}

/**
 * Loads optional profiles from <worktreePath>/.duoidal/compose-config.json.
 * Returns an empty array if the file doesn't exist or has no profiles.
 */
function loadProfiles(worktreePath: string): string[] {
  const configPath = path.join(worktreePath, '.duoidal', 'compose-config.json')
  if (!fs.existsSync(configPath)) return []
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const config = JSON.parse(raw)
    if (Array.isArray(config.profiles)) {
      const SAFE_PROFILE = /^[a-zA-Z0-9_-]+$/
      return (config.profiles as string[]).filter(p => typeof p === 'string' && SAFE_PROFILE.test(p))
    }
  } catch {
    console.error(`[compose] Failed to parse compose-config.json: ${configPath}`)
  }
  return []
}

async function provision(
  ctx: ProvisionContext,
  _slug: string,
  opts?: Record<string, string>,
): Promise<void> {
  if (!ctx.worktreePath) {
    console.log('[compose] worktreePath not set — skipping compose provisioning')
    return
  }

  // Unconditional install+build — every dispatch worktree needs node_modules and dist/
  // before any Docker services (or the agent loop) can run.
  // Sentinel: node_modules/.install-hash (sha256 of pnpm-lock.yaml) → skip when warm.
  const lockfilePath = path.join(ctx.worktreePath, 'pnpm-lock.yaml')
  if (fs.existsSync(lockfilePath)) {
    const lockfileContent = fs.readFileSync(lockfilePath)
    const lockfileHash = createHash('sha256').update(lockfileContent).digest('hex')

    const installSentinelPath = path.join(ctx.worktreePath, 'node_modules', '.install-hash')
    const existingInstallHash = fs.existsSync(installSentinelPath)
      ? fs.readFileSync(installSentinelPath, 'utf8').trim()
      : ''

    if (existingInstallHash !== lockfileHash) {
      console.log('[compose] Running pnpm install --frozen-lockfile in worktree...')
      const installResult = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
        cwd: ctx.worktreePath,
        stdio: 'pipe',
        timeout: 300_000, // 5 min
        maxBuffer: 64 * 1024 * 1024, // 64 MB — monorepo install output can exceed 1 MB default
      })
      if (installResult.status !== 0 || installResult.error) {
        const stderr = installResult.stderr?.toString().trim() ?? ''
        const reason = installResult.error
          ? `${installResult.error.message} (signal: ${installResult.signal ?? 'none'})`
          : stderr || '(no stderr)'
        throw new Error(`[compose] pnpm install failed in ${ctx.worktreePath}: ${reason}`)
      }
      const installStdout = installResult.stdout?.toString().trim()
      if (installStdout) console.log(`[compose] pnpm install output:\n${installStdout}`)
      fs.mkdirSync(path.dirname(installSentinelPath), { recursive: true })
      fs.writeFileSync(installSentinelPath, lockfileHash, 'utf8')
      console.log('[compose] pnpm install complete, sentinel written')
    } else {
      console.log('[compose] pnpm install skipped (warm — lockfile hash matches)')
    }

    // Build via Turborepo so cross-worktree builds hit a shared content-hashed
    // cache. Turbo computes its own hash over the `inputs` declared in
    // turbo.json (sources, lockfile, package.json, configs) and skips the build
    // entirely on a hit. The previous sentinel here keyed only on the lockfile
    // hash, which is wrong: source-only changes would serve a stale `dist/`.
    const turboCacheDir = resolveTurboCacheDir()
    fs.mkdirSync(turboCacheDir, { recursive: true })
    console.log(`[compose] Running turbo run build (cache: ${turboCacheDir})...`)
    const buildResult = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build'], {
      cwd: ctx.worktreePath,
      stdio: 'pipe',
      timeout: 600_000, // 10 min — first cold build can exceed 5 min on a fresh host cache
      maxBuffer: 64 * 1024 * 1024, // 64 MB — monorepo build output can exceed 1 MB default
      env: { ...process.env, TURBO_CACHE_DIR: turboCacheDir },
    })
    if (buildResult.status !== 0 || buildResult.error) {
      const stderr = buildResult.stderr?.toString().trim() ?? ''
      const reason = buildResult.error
        ? `${buildResult.error.message} (signal: ${buildResult.signal ?? 'none'})`
        : stderr || '(no stderr)'
      throw new Error(`[compose] turbo run build failed in ${ctx.worktreePath}: ${reason}`)
    }
    const buildStdout = buildResult.stdout?.toString().trim()
    if (buildStdout) console.log(`[compose] turbo build output:\n${buildStdout}`)
    console.log('[compose] turbo run build complete')
  } else {
    console.log('[compose] No pnpm-lock.yaml found — skipping install/build')
  }

  const composePath = findComposePath(ctx.worktreePath)
  if (composePath) {
    console.log(`[compose] Found compose file: ${composePath}`)

    if (!isDockerAvailable()) {
      throw new Error('Docker is required for compose provisioning but is not installed')
    }

    const sharedDir = path.join(ctx.worktreePath, '.compose-shared')
    fs.mkdirSync(sharedDir, { recursive: true })

    const profiles = loadProfiles(ctx.worktreePath)
    // Add build-local profile when --build-local is set and --skip-build-local is not
    if (opts?.['build-local'] === 'true' && opts?.['skip-build-local'] !== 'true') {
      profiles.push('build-local')
    }
    const projectName = projectNameFor(ctx.worktreePath)

    const args = [
      'compose', '-f', composePath,
      ...profiles.flatMap(p => ['--profile', p]),
      'up', '-d', '--wait', '--wait-timeout', '120',
    ]
    const result = spawnSync('docker', args, {
      env: { ...process.env, COMPOSE_PROJECT_NAME: projectName, WORKTREE_PATH: ctx.worktreePath },
      stdio: 'pipe',
      timeout: 150_000,
    })
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? ''
      throw new Error(`[compose] docker compose up failed: ${stderr}`)
    }
    console.log(`[compose] Services started for project ${projectName}`)

    // Write .duoidal/compose-project so CLI commands and resume flow can read the project name
    const duoidalDir = path.join(ctx.worktreePath, '.duoidal')
    fs.mkdirSync(duoidalDir, { recursive: true })
    fs.writeFileSync(path.join(duoidalDir, 'compose-project'), projectName, 'utf8')
    console.log(`[compose] Wrote .duoidal/compose-project: ${projectName}`)

    // Parse env from shared volume and propagate to context
    for (const [k, v] of parseSharedEnv(sharedDir)) ctx.setEnv(k, v)

    // Discover dynamically assigned host ports and propagate to context
    for (const [k, v] of discoverPorts(projectName)) ctx.setEnv(k, v)
  }

  // Binary resolution — runs unconditionally (not gated on composePath) because every dispatch
  // needs SKILL_NETWORKS_CLI regardless of whether a compose.yml is present. It lives here
  // because this provisioner runs after worktree (giving us ctx.worktreePath) and before the
  // loop. A dedicated cli-resolver provisioner would be cleaner but adds churn for no gain.
  //
  // Note: SKILL_NETWORKS_CLI is parsed by getCliCommand() which splits on spaces, so binary
  // paths with whitespace cannot be used directly — fall through to PATH/npx in that case.
  // 1. Local worktree binary (node_modules/.bin/duoidal) — present in monorepo workspace installs
  // 2. duoidal on PATH — present when installed globally or via the published container image
  // 3. npx --yes @duoidal/cli — last resort for environments with neither (fetches from registry)
  const localBin = path.join(ctx.worktreePath, 'node_modules', '.bin', 'duoidal')
  if (fs.existsSync(localBin) && !/\s/.test(localBin)) {
    ctx.setEnv('SKILL_NETWORKS_CLI', localBin)
    console.log(`[compose] Using local binary at ${localBin}`)
  } else {
    if (fs.existsSync(localBin)) {
      console.warn(`[compose] Local binary path contains whitespace, skipping: ${localBin}`)
    }
    const probe = spawnSync('duoidal', ['--version'], { stdio: 'pipe', timeout: 5_000 })
    if (probe.status === 0) {
      ctx.setEnv('SKILL_NETWORKS_CLI', 'duoidal')
      console.log('[compose] Using duoidal from PATH')
    } else {
      if (probe.error) {
        console.log(`[compose] PATH probe: ${probe.error.message}`)
      } else if (probe.status !== null) {
        console.log(`[compose] PATH probe exited ${probe.status}: ${probe.stderr?.toString() ?? ''}`)
      }
      ctx.setEnv('SKILL_NETWORKS_CLI', 'npx --yes @duoidal/cli')
      console.log('[compose] duoidal not found locally — falling back to npx --yes @duoidal/cli')
    }
  }
}

export async function teardown(
  ctx: ProvisionContext,
  _slug: string,
): Promise<void> {
  if (!ctx.worktreePath) return

  const sharedDir = path.join(ctx.worktreePath, '.compose-shared')
  if (!fs.existsSync(sharedDir)) return

  const projectName = projectNameFor(ctx.worktreePath)

  // Step 1: Dump postgres if running (best-effort, no-op if no database service found)
  // The compose.yml in this repo names the postgres service "database".
  const POSTGRES_SERVICE = 'database'
  let dumpSucceeded = false
  const ps = spawnSync('docker', ['compose', '-p', projectName, 'ps', '--format', 'json'], {
    stdio: 'pipe',
    timeout: 30_000,
  })
  if (ps.status !== 0) {
    console.warn(`[compose] docker compose ps failed (status ${ps.status ?? 'null'}): ${ps.stderr?.toString() ?? ''} — assuming no postgres`)
  }
  // Match the exact service name in the JSON output from `docker compose ps --format json`.
  const psOutput = ps.stdout?.toString() ?? ''
  const hasPostgres = psOutput.includes(`"Service":"${POSTGRES_SERVICE}"`) || psOutput.includes(`"Name":"${POSTGRES_SERVICE}"`)
  if (hasPostgres) {
    const dump = spawnSync(
      'docker',
      ['compose', '-p', projectName, 'exec', '-T', POSTGRES_SERVICE, 'pg_dump', '--clean', '--if-exists', '-U', 'postgres', '-d', 'postgres'],
      { stdio: 'pipe', timeout: 60_000, maxBuffer: 512 * 1024 * 1024 },
    )
    if (dump.status === 0 && dump.stdout?.length) {
      const snapshotPath = path.join(ctx.worktreePath, 'workspace', 'db-snapshot.sql')
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
      fs.writeFileSync(snapshotPath, dump.stdout, { mode: 0o600 })
      console.log('[compose] DB snapshot saved to workspace/db-snapshot.sql')
      dumpSucceeded = true
    } else {
      console.warn(`[compose] DB dump warning: pg_dump failed or empty — ${dump.stderr?.toString() ?? ''}`)
      console.warn('[compose] Skipping volume deletion to preserve DB data — run "docker compose down -v" manually after resolving the issue')
    }
  }

  // Step 2: Stop services + remove the per-worktree built images.
  //
  // `--rmi local` removes only images this project built itself (e.g.
  // wt-<slug>-database, wt-<slug>-credential-proxy). Pulled images
  // (postgres:16-alpine, supabase/studio, etc.) are preserved because they
  // are shared across every dispatch. Without this flag, every dispatch
  // leaves ~400MB+ per built service on disk forever — a 12-deep graveyard
  // of stale wt-*-database:latest tags accumulated and pushed openclaw to
  // 88% disk usage on May 4 2026, killing five parallel dispatches with
  // -ENOSPC. `compose down -v` alone never cleaned them up because, by
  // docker-compose design, image removal is opt-in.
  //
  // Volume deletion (-v) is omitted when a postgres dump was attempted but
  // failed, to avoid data loss. Image removal stays in either branch since
  // the per-worktree image is reproducible from the worktree's Dockerfile,
  // not user data.
  const downArgs = (hasPostgres && !dumpSucceeded)
    ? ['compose', '-p', projectName, 'down', '--rmi', 'local']
    : ['compose', '-p', projectName, 'down', '-v', '--rmi', 'local']
  const result = spawnSync('docker', downArgs, {
    stdio: 'pipe',
    timeout: 120_000,
  })
  if (result.status !== 0) {
    console.error(
      `[compose] teardown warning: docker compose down failed: ${result.stderr?.toString()}`,
    )
  }
}

export const composeProvisioner: Provisioner = {
  name: 'compose',
  runsAfter: ['worktree'],
  provision,
  teardown,
}

export default composeProvisioner
