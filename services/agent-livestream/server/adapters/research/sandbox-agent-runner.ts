/**
 * runSandboxAgent — runs research.mjs inside the user's sandbox VM via SSH.
 *
 * Responsibilities:
 * - Upload sandbox-scripts/research.mjs to the sandbox if needed
 * - Run it with the user's prompt, passing ANTHROPIC_BASE_URL and SANDBOX_ID
 * - Parse stdout JSON: { text }
 * - Does NOT import the claude-code SDK — that lives only in research.mjs
 * - Does NOT pick ports, build URLs, or render HTML — the sandbox owns all of that
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SshManager } from './ssh-manager.js'
import { createLogger } from '@skill-networks/logger'
import { RESEARCH } from '../../constants.js'

const logger = createLogger('agent-livestream:sandbox-agent-runner')

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESEARCH_SCRIPT_PATH = resolve(__dirname, '../../sandbox-scripts/research.mjs')

const DEFAULT_TIMEOUT_MS = 300_000

export interface SandboxRunResult {
  /** Plain-text summary. May contain a URL inline if the sandbox spawned an
   *  artifact server. The voice/chat agent decides whether to call
   *  share_screen with that URL — this runner does not auto-render. */
  text: string
}

export interface SandboxAgentRunnerOptions {
  /** SSH host (e.g. IP address of the sandbox VM) */
  host: string
  /** PEM-format private key content */
  privateKey: string
  /** The sandbox resource ID — passed into the script for artifact URL construction */
  sandboxId: string
  /** Timeout in ms (default 300 000) */
  timeoutMs?: number
  /** Injectable SshManager for testing */
  ssh?: SshManager
}

// SshManager reads OPENCLAW_HOST / OPENCLAW_SSH_KEY in its constructor. Since the
// constructor is synchronous with no I/O, the mutation window contains no awaits
// and is safe in Node.js's single-threaded model.
function createSshManager(host: string, privateKey: string): SshManager {
  const savedHost = process.env['OPENCLAW_HOST']
  const savedKey = process.env['OPENCLAW_SSH_KEY']
  // Sandbox config.ip is bare (e.g. "10.0.0.1"). The ssh master spawns
  // `ssh <host>` — without user@ it defaults to the current OS user. Prepend
  // root@ so the SSH key actually authenticates against the right account.
  const sshTarget = host.includes('@') ? host : `root@${host}`
  process.env['OPENCLAW_HOST'] = sshTarget
  process.env['OPENCLAW_SSH_KEY'] = privateKey
  const mgr = new SshManager()
  if (savedHost === undefined) delete process.env['OPENCLAW_HOST']
  else process.env['OPENCLAW_HOST'] = savedHost
  if (savedKey === undefined) delete process.env['OPENCLAW_SSH_KEY']
  else process.env['OPENCLAW_SSH_KEY'] = savedKey
  return mgr
}

export async function runSandboxAgent(
  prompt: string,
  opts: SandboxAgentRunnerOptions,
): Promise<SandboxRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ssh = opts.ssh ?? createSshManager(opts.host, opts.privateKey)

  let scriptContent: string
  try {
    scriptContent = readFileSync(RESEARCH_SCRIPT_PATH, 'utf-8')
  } catch (err) {
    throw new Error(
      `runSandboxAgent: cannot read research script at ${RESEARCH_SCRIPT_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const safePrompt = prompt.replace(/'/g, "'\\''")
  const safeSandboxId = opts.sandboxId.replace(/'/g, "'\\''")
  const safeBase64Script = Buffer.from(scriptContent).toString('base64')

  // The script must run from RESEARCH.SANDBOX_WORKDIR so ESM resolution finds
  // the locally-installed @anthropic-ai/claude-agent-sdk in its node_modules.
  // /tmp doesn't have node_modules; placing the script there breaks imports.
  const command = [
    `cd '${RESEARCH.SANDBOX_WORKDIR}'`,
    `SCRIPT_PATH="${RESEARCH.SANDBOX_WORKDIR}/research-$$.mjs"`,
    `trap 'rm -f "$SCRIPT_PATH"' EXIT`,
    `echo '${safeBase64Script}' | base64 -d > "$SCRIPT_PATH"`,
    `ANTHROPIC_BASE_URL='${RESEARCH.SANDBOX_ANTHROPIC_BASE_URL}' ` +
      `ANTHROPIC_API_KEY='${RESEARCH.SANDBOX_ANTHROPIC_API_KEY}' ` +
      `SANDBOX_ID='${safeSandboxId}' ` +
      `SANDBOX_MODEL='${RESEARCH.SANDBOX_MODEL}' ` +
      `node "$SCRIPT_PATH" '${safePrompt}'`,
  ].join('\n')

  let stdout: string
  try {
    stdout = await ssh.execOnOpenClaw(command, timeoutMs)
  } catch (err) {
    throw new Error(
      `runSandboxAgent SSH error: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    ssh.close()
  }

  // The script may emit log lines before the final JSON. Scan from the end
  // for the last line that parses as { text: string }.
  const lines = stdout.split('\n').reverse()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const candidate = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof candidate['text'] === 'string') {
        return { text: candidate['text'] }
      }
    } catch {
      // not JSON — keep scanning
    }
  }

  logger.warn('runSandboxAgent: no JSON {text} found in stdout, using raw output', {
    stdoutLength: stdout.length,
  })
  return { text: stdout.trim() || 'No result' }
}
