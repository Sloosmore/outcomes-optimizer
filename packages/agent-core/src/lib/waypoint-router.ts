import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getSupabaseServiceKey, getSupabaseUrl } from '@skill-networks/database/constants'
import type { DispatchConfig } from './dispatch-config.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Shell-quotes a value using single-quote wrapping.
 * Prevents command injection when env var values are interpolated into the remote command prefix.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export interface WaypointResult {
  local: boolean
}

interface PreflightArgs {
  name: string
  host: string
  user: string
  key: string
  container: string
}

/**
 * Probes the remote container via `docker exec` before dispatching.
 *
 * Catches (a) rotten OCI exec state on long-running containers, (b) containers
 * where start.sh has not yet installed duoidal/node/npx, and (c) any other
 * docker-exec pathology that would otherwise surface as a cryptic 'executable
 * file not found' (exit 127) from the real dispatch. Converts those failures
 * into an actionable error message with remediation steps.
 *
 * Hard 15s timeout so it can never hang the caller — probe is strictly additive.
 */
function preflightProbeContainer(args: PreflightArgs): void {
  const { name, host, user, key, container } = args
  // Verify all three tools the dispatch path actually relies on: node + npx are
  // needed before duoidal (we invoke via `npx duoidal execute`) and duoidal itself
  // may be installed as a global bin. Probing all three catches mid-boot containers
  // where start.sh is partway through installing dependencies. Each missing tool
  // writes a distinct marker to stderr so the caller's error message identifies
  // the actual gap instead of just reporting "exit 127".
  const probeInner =
    `{ command -v node >/dev/null || { echo "preflight: node not in PATH" >&2; exit 127; }; } && ` +
    `{ command -v npx >/dev/null || { echo "preflight: npx not in PATH" >&2; exit 127; }; } && ` +
    `{ command -v duoidal >/dev/null || { echo "preflight: duoidal not in PATH" >&2; exit 127; }; } && ` +
    `duoidal --version`
  // Single-quote the inner script for `sh -c` and escape any embedded single quotes.
  const probeRemote = `docker exec ${container} sh -c ${shellQuote(probeInner)}`
  const probe = spawnSync('ssh', [
    '-i', key,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '--', `${user}@${host}`, probeRemote,
  ], { encoding: 'utf8', timeout: 15000 })

  if (probe.status === 0) return

  const stderr = probe.stderr?.trim() ?? ''
  const stdout = probe.stdout?.trim() ?? ''
  const detail = stderr || stdout || (probe.error ? probe.error.message : `exit ${probe.status ?? '(unknown)'}`)
  throw new Error(
    `Pre-flight check failed: duoidal not runnable inside container '${container}' on ${name} (${host}).\n` +
    `detail: ${detail}\n` +
    `Remediation: SSH in and run 'cd /opt/runtime && docker compose down && docker compose up -d', ` +
    `then wait for start.sh to finish (docker logs ${container} --tail 20 to watch).`
  )
}

interface TokenRefreshArgs {
  host: string
  user: string
  key: string
  container: string
}

const CONTAINER_TOKEN_PATH = '/root/.config/duoidal/token.json'

/**
 * Idempotently pushes the local user's auth token into the remote container,
 * then validates the push by running `duoidal auth whoami` inside the container.
 *
 * The nested `duoidal execute` that runs inside the container reads
 * `/root/.config/duoidal/token.json` via `requireAuth()`. If the container
 * has no token (fresh boot, recreated, never initialized), that nested
 * command fails immediately with "Not authenticated". Users previously
 * worked around this with a one-off `docker cp` of their local token —
 * fragile because it's lost on container recreate and never picks up a
 * re-authed local token.
 *
 * This function makes the local token the source of truth: every dispatch
 * overwrites the container's copy. When the user re-auths locally, the
 * container stays in sync automatically on the next dispatch.
 *
 * Secret handling:
 * - The token content is passed via stdin to a remote `sh -c 'cat > ...'`
 *   heredoc. It never lands on the openclaw HOST filesystem — only in
 *   process memory on the host, then directly into the container's file.
 * - The container file is chmod 600 to keep it unreadable by other container
 *   users, matching the local token's posture.
 * - We do NOT forward the token as a `-e DUOIDAL_TOKEN=...` env flag: env
 *   vars show up in `ps aux` inside the container and can leak via traces.
 *
 * Failure mode: fatal. If the push fails or if post-push auth validation
 * (`duoidal auth whoami` inside the container) exits non-zero, we throw
 * immediately with the token path and the auth failure reason. A silent
 * stall is far harder to debug than a fast, explicit failure — and the
 * user has a clear remediation: `duoidal auth refresh` locally, then
 * re-dispatch.
 *
 * No-op when the local token is missing: throw immediately so the user
 * knows they must run `duoidal auth login` before dispatching to a remote
 * container. Silently continuing would result in an opaque stall inside
 * the container, which is worse than a fast, clear error here.
 *
 * Hard timeouts: push 20s, validation 5s — together they guarantee the
 * combined step cannot hang the dispatch flow for more than ~25s.
 */
function refreshContainerToken(args: TokenRefreshArgs): void {
  const { host, user, key, container } = args

  const localTokenPath = path.join(os.homedir(), '.config', 'duoidal', 'token.json')
  let localTokenContent: string | null = null
  try {
    if (fs.existsSync(localTokenPath)) {
      localTokenContent = fs.readFileSync(localTokenPath, 'utf-8')
    }
  } catch {
    throw new Error(
      `Token push to container '${container}' aborted: could not read local token at ${localTokenPath}.\n` +
      `Resolve: run \`duoidal auth login\` locally then re-dispatch.`
    )
  }

  if (!localTokenContent) {
    // No local token — fail fast so the user gets a clear error here rather
    // than a silent stall or cryptic "Not authenticated" deep inside the container.
    throw new Error(
      `Token push to container '${container}' failed: no local token found at ${localTokenPath}.\n` +
      `Token path: ${CONTAINER_TOKEN_PATH}\n` +
      `Auth error: local token file missing — run \`duoidal auth login\` first.\n` +
      `Resolve: run \`duoidal auth login\` locally then re-dispatch.`
    )
  }

  // Shell heredoc via stdin: `cat > <file>` writes stdin to the file inside
  // the container. The token bytes travel ssh → docker exec stdin → file,
  // never touching any host-side filesystem.
  // One docker exec, not two: chaining `mkdir && cat` across separate
  // `docker exec -i` invocations consumes ssh stdin in the first call and
  // leaves the second `cat` reading EOF — silently truncating token.json.
  const pushCmd =
    `docker exec -i ${container} sh -c 'mkdir -p /root/.config/duoidal && cat > /root/.config/duoidal/token.json && chmod 600 /root/.config/duoidal/token.json'`
  const pushResult = spawnSync('ssh', [
    '-i', key,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=20',
    '--', `${user}@${host}`, pushCmd,
  ], { input: localTokenContent, encoding: 'utf8', timeout: 20_000 })

  if (pushResult.status !== 0) {
    const detail = pushResult.stderr?.trim() || pushResult.error?.message || `exit ${pushResult.status ?? '(unknown)'}`
    throw new Error(
      `Token push to container '${container}' failed: ${detail}\n` +
      `Token path: ${CONTAINER_TOKEN_PATH}\n` +
      `Auth error: push command exited non-zero — ${detail}\n` +
      `Resolve: run \`duoidal auth refresh\` locally then re-dispatch.`
    )
  }

  // Post-push validation: verify the token file is present and readable inside the
  // container. `duoidal auth whoami` exits 0 when a valid token file exists (even
  // if the JWT is expired), and exits 1 when no token file exists or the file is
  // malformed — sufficient to satisfy the "token present before SDK starts" requirement.
  // We deliberately avoid `duoidal health` here: its `scope` check network-calls the
  // DB and will fail with fake tokens used in unit tests. Hard 5s timeout so a hung
  // container cannot stall dispatch indefinitely.
  const validateCmd = `docker exec ${container} duoidal auth whoami`
  const validateResult = spawnSync('ssh', [
    '-i', key,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=5',
    '--', `${user}@${host}`, validateCmd,
  ], { encoding: 'utf8', timeout: 5_000 })

  if (validateResult.status !== 0) {
    const authDetail =
      validateResult.stderr?.trim() ||
      validateResult.stdout?.trim() ||
      validateResult.error?.message ||
      `exit ${validateResult.status ?? '(unknown)'}`
    throw new Error(
      `Token push to container '${container}' succeeded but auth validation failed:\n` +
      `  Token path: ${CONTAINER_TOKEN_PATH}\n` +
      `  Auth error: ${authDetail}\n` +
      `Resolve: run \`duoidal auth refresh\` locally then re-dispatch.`
    )
  }
}

export function routeToServer(
  config: DispatchConfig,
  skillResourceId: string,
  epochs: number,
  opts?: { hopCount?: number; unlinked?: boolean; pr?: boolean }
): WaypointResult {
  const hopCount = opts?.hopCount ?? 0

  if (hopCount > 5) {
    throw new Error('Waypoint chain exceeded maximum depth (5 hops)')
  }

  // Defense-in-depth: validate inputs that will be interpolated into a remote shell command
  if (!UUID_RE.test(skillResourceId)) {
    throw new Error(`routeToServer: invalid skillResourceId: ${skillResourceId}`)
  }
  if (!Number.isInteger(epochs) || epochs <= 0) {
    throw new Error(`routeToServer: invalid epochs: ${epochs}`)
  }

  if (config.server === 'self') {
    return { local: true }
  }

  const name = config.server
  const serverConfig = config.servers?.[name]
  if (!serverConfig) {
    throw new Error(`Server '${name}' not found in config.servers`)
  }

  const { host, user, key } = serverConfig

  // Prevent SSH options injection: fields starting with '-' would be interpreted as SSH flags
  if (host.startsWith('-') || user.startsWith('-') || key.startsWith('-')) {
    throw new Error(`Server '${name}' config fields must not start with '-' (options injection guard)`)
  }

  const unlinkedFlag = opts?.unlinked ? ' --unlinked' : ''
  // Forward the local --pr / --no-pr choice across the SSH hop. If the caller
  // didn't pass the flag (undefined), omit it and let the remote CLI's default
  // apply. execute.ts always resolves pr to a boolean before calling here, so
  // the omit path is reserved for future callers that intentionally have no
  // explicit preference (e.g. library consumers or internal recursive hops).
  const prFlag = opts?.pr === true ? ' --pr' : opts?.pr === false ? ' --no-pr' : ''
  const worktreeRepo = serverConfig.worktree_repo
  const duoidalApiUrl = process.env['DUOIDAL_API_URL']
  // Pass database URL so remote can connect to DB (Supavisor JWT auth not viable for remote VMs)
  const dbUrl = process.env['SKILL_NETWORKS_DATABASE_URL'] || process.env['DATABASE_URL']
  const envParts: string[] = []
  if (worktreeRepo) envParts.push(`WORKTREE_REPO=${shellQuote(worktreeRepo)}`)
  if (duoidalApiUrl) envParts.push(`DUOIDAL_API_URL=${shellQuote(duoidalApiUrl)}`)
  if (dbUrl) envParts.push(`SKILL_NETWORKS_DATABASE_URL=${shellQuote(dbUrl)}`)
  // On remote machines the CLI is globally installed, not in a pnpm workspace.
  // SKILL_NETWORKS_CLI=duoidal tells dispatch.ts to invoke the global binary.
  envParts.push('SKILL_NETWORKS_CLI=duoidal')
  // Disable interactive git prompts so git operations fail fast instead of blocking
  envParts.push('GIT_TERMINAL_PROMPT=0')
  // Supabase credentials for worktree provisioning (storage bucket access).
  // URL always resolves via helper (falls back to prod); service key is opt-in
  // (throws when unset), so we catch and skip to preserve forwarding semantics.
  envParts.push(`SUPABASE_URL=${shellQuote(getSupabaseUrl())}`)
  try {
    const supabaseServiceKey = getSupabaseServiceKey()
    envParts.push(`SUPABASE_SERVICE_KEY=${shellQuote(supabaseServiceKey)}`)
  } catch {
    // Service key not set — do not forward.
  }
  // Anthropic API key for claude-agent-sdk adapter on remote machines
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY']
  if (anthropicApiKey) envParts.push(`ANTHROPIC_API_KEY=${shellQuote(anthropicApiKey)}`)
  // ANTHROPIC_BASE_URL for claude-agent-sdk adapter.
  // Local Docker bridge addresses (172.x.x.x) are not reachable from remote VMs.
  // Resolve the public IP so the remote can reach the same proxy.
  const anthropicBaseUrl = process.env['ANTHROPIC_BASE_URL']
  if (anthropicBaseUrl) {
    // Replace loopback or Docker bridge addresses with the machine's public IP.
    // This allows the remote to reach the same credential proxy that the dispatch machine uses.
    const publicIpResult = spawnSync('curl', ['-sf', '--connect-timeout', '3', 'https://api.ipify.org'], { encoding: 'utf8' })
    const rawPublicIp = publicIpResult.status === 0 ? (publicIpResult.stdout?.trim() ?? '') : ''
    // Validate IPv4 format to prevent unexpected content from api.ipify.org being used as an address
    const publicIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(rawPublicIp) ? rawPublicIp : null
    let resolvedUrl = anthropicBaseUrl
    if (publicIp) {
      // Replace 172.x.x.x or 127.0.0.1 with the public IP so remote machines can reach the proxy
      resolvedUrl = anthropicBaseUrl.replace(/\b172\.\d+\.\d+\.\d+\b/, publicIp).replace('127.0.0.1', publicIp).replace('localhost', publicIp)
    }
    envParts.push(`ANTHROPIC_BASE_URL=${shellQuote(resolvedUrl)}`)
  }
  const execCmd = `npx duoidal execute --skill-resource-id ${skillResourceId} --epochs ${epochs} --hops ${hopCount + 1}${unlinkedFlag}${prFlag}`

  let remoteCmd: string
  if (serverConfig.container) {
    // Wrap in docker exec — env vars passed as -e flags, -w sets working directory
    const container = serverConfig.container
    if (!/^[A-Za-z0-9_.\-]+$/.test(container)) {
      throw new Error(`Server '${name}' has unsafe container name: ${container}`)
    }

    // Pre-flight probe: verify the container can actually exec the required binaries
    // before we dispatch. This catches rotten OCI exec specs, containers that booted
    // before start.sh finished installing duoidal, and other docker-exec pathologies
    // that would otherwise surface as a cryptic 'executable file not found' (exit 127)
    // mid-dispatch. Failing here turns that into a human-readable, actionable error.
    preflightProbeContainer({ name, host, user, key, container })

    // Idempotently sync the local user's auth token into the container and
    // validate it. The nested `duoidal execute` reads ~/.config/duoidal/token.json
    // for auth; without this step, a fresh or recreated container has no token
    // and the nested command fails immediately with "Not authenticated". Throws
    // on push failure or auth validation failure — see refreshContainerToken.
    refreshContainerToken({ host, user, key, container })

    // Thread the originating server name across the SSH hop so the nested
    // `duoidal execute` running inside the container knows this dispatch originated
    // from a remote hop (not a laptop-local tmux run). dispatch.ts reads this env
    // var to record `run_type = 'cloud'` instead of defaulting to 'local'.
    // Only set on the docker-exec remote path — never on `server: self` (that path
    // is genuinely local and the env var would mis-label the process row).
    const runTypeEnv = `DUOIDAL_RUN_TYPE=${shellQuote(name)}`
    const containerEnvParts = [...envParts, runTypeEnv]

    const workdir = worktreeRepo ? `-w ${shellQuote(worktreeRepo)} ` : ''
    const envFlags = containerEnvParts.map(p => `-e ${p}`).join(' ')
    remoteCmd = `docker exec ${workdir}${envFlags ? envFlags + ' ' : ''}${container} ${execCmd}`
  } else {
    const envPrefix = envParts.length > 0 ? `${envParts.join(' ')} ` : ''
    remoteCmd = `${envPrefix}${execCmd}`
  }

  // '--' terminates SSH option parsing, preventing a destination like '-oProxyCommand=...' from
  // being interpreted as an SSH option.
  // StrictHostKeyChecking=accept-new accepts new host keys but rejects changed ones (TOFU model).
  // ConnectTimeout=30 avoids indefinite hangs on unreachable hosts.
  const result = spawnSync('ssh', [
    '-i', key,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=30',
    '--', `${user}@${host}`, remoteCmd,
  ], { stdio: 'inherit' })

  if (result.error) {
    throw new Error(`SSH to ${name} failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`SSH to ${name} exited with code ${result.status ?? '(unknown)'}`)
  }

  return { local: false }
}
