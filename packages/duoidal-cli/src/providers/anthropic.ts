import { spawnSync as nodeSpawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import type { ProviderAdapter, LinkOptions, UnlinkOptions } from './types.js'
import { CLIProxyAPINotFoundError, SandboxUnreachableError } from './types.js'

type SpawnSyncFn = (
  command: string,
  args: string[],
  options?: { input?: string; encoding?: string; timeout?: number }
) => SpawnSyncReturns<string>

function buildConfigYaml(apiKey: string): string {
  // ANTHROPIC_BASE_URL may point to a Docker-internal interceptor (e.g. 172.18.0.1:8317).
  // ANTHROPIC_BASE_URL_EXTERNAL overrides it with an address reachable from the sandbox.
  const rawBaseUrl = process.env['ANTHROPIC_BASE_URL_EXTERNAL'] ?? process.env['ANTHROPIC_BASE_URL'] ?? ''
  const baseUrlLine = rawBaseUrl ? `\n    base-url: "${rawBaseUrl}"` : ''
  return `auth-dir: ~/CLIProxyAPI/auths
port: 8317
api-keys:
  - duoidal-key
claude-api-key:
  - api-key: "${apiKey}"${baseUrlLine}
`
}

function buildSshBaseArgs(keyPath: string, ip: string): string[] {
  return [
    '-i', keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15',
    `root@${ip}`,
  ]
}

function runSsh(
  spawnSync: SpawnSyncFn,
  ip: string,
  keyPath: string,
  command: string,
  input?: string
): SpawnSyncReturns<string> {
  const args = [...buildSshBaseArgs(keyPath, ip), command]
  return spawnSync('ssh', args, {
    input,
    encoding: 'utf-8',
    timeout: 30000,
  })
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic'
  readonly category = 'model' as const

  private readonly spawnSync: SpawnSyncFn

  constructor(spawnSyncFn?: SpawnSyncFn) {
    this.spawnSync = spawnSyncFn ?? (nodeSpawnSync as unknown as SpawnSyncFn)
  }

  async link(opts: LinkOptions): Promise<void> {
    const { credential, sandbox } = opts
    if (!sandbox) {
      throw new Error('AnthropicAdapter.link requires opts.sandbox (ip + keyPath)')
    }
    const { ip, keyPath } = sandbox

    // 1. Test SSH connectivity
    const connectResult = runSsh(this.spawnSync, ip, keyPath, 'echo ok')
    if (connectResult.status !== 0) {
      throw new SandboxUnreachableError(ip)
    }

    // 2. Check CLIProxyAPI exists
    const lsResult = runSsh(this.spawnSync, ip, keyPath, 'test -f ~/CLIProxyAPI/cli-proxy-api')
    if (lsResult.status !== 0) {
      throw new CLIProxyAPINotFoundError(ip)
    }

    // 3. Build auth JSON in memory — credential never passed as CLI argument
    const now = new Date()
    const oneYearFromNow = new Date(now)
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1)

    const authJson = {
      access_token: credential,
      refresh_token: '',
      email: 'duoidal-user',
      expired: oneYearFromNow.toISOString(),
      last_refresh: now.toISOString(),
      disabled: false,
      type: 'claude',
    }

    // 4. Write auth file via stdin pipe — credential is NEVER in command args
    const writeAuthResult = runSsh(
      this.spawnSync,
      ip,
      keyPath,
      'mkdir -p ~/CLIProxyAPI/auths && cat > ~/CLIProxyAPI/auths/user.json && chmod 0600 ~/CLIProxyAPI/auths/user.json',
      JSON.stringify(authJson)
    )
    if (writeAuthResult.status !== 0) {
      throw new Error(`Failed to write auth file on sandbox ${ip}: ${writeAuthResult.stderr}`)
    }

    // 5. Always write config.yaml with claude-api-key section — credential piped via stdin
    const configYaml = buildConfigYaml(credential)
    const writeConfigResult = runSsh(
      this.spawnSync,
      ip,
      keyPath,
      'cat > ~/CLIProxyAPI/config.yaml && chmod 0600 ~/CLIProxyAPI/config.yaml',
      configYaml
    )
    if (writeConfigResult.status !== 0) {
      throw new Error(`Failed to write config.yaml on sandbox ${ip}: ${writeConfigResult.stderr}`)
    }

    // 6. Start/restart CLIProxyAPI
    // Kill any existing instance first by port to avoid pattern-matching the SSH session's bash process.
    // fuser -k 8317/tcp kills the process listening on port 8317 without matching on command name.
    const alreadyRunning = runSsh(this.spawnSync, ip, keyPath, 'nc -z -w1 localhost 8317 2>/dev/null && echo RUNNING || echo STOPPED')
    if (alreadyRunning.stdout.includes('RUNNING')) {
      runSsh(this.spawnSync, ip, keyPath, 'fuser -k 8317/tcp 2>/dev/null || true && sleep 1')
    }
    // Start CLIProxyAPI in a subshell with all FDs redirected to break the SSH session's
    // file descriptor inheritance. nohup + unredirected FDs cause the SSH session to hang
    // until the spawnSync timeout (30s) because the child inherits the SSH tunnel's FDs.
    // Using (... </dev/null >>/tmp/cliproxyapi.log 2>&1 &) inside a subshell ensures
    // the child detaches from SSH immediately and the session returns in <2s.
    const startResult = runSsh(
      this.spawnSync,
      ip,
      keyPath,
      'cd ~/CLIProxyAPI && (./cli-proxy-api -config config.yaml </dev/null >>/tmp/cliproxyapi.log 2>&1 &)'
    )
    if (startResult.status !== 0) {
      throw new Error(`Failed to start CLIProxyAPI on sandbox ${ip}: ${startResult.stderr}`)
    }

    // Poll until port 8317 is accepting connections (up to 30s).
    // Use nc (netcat) which is available on all Ubuntu images; avoids ss/iproute2 dependency.
    const pollResult = runSsh(
      this.spawnSync,
      ip,
      keyPath,
      'for i in $(seq 1 15); do sleep 2; if nc -z -w1 localhost 8317 2>/dev/null; then echo READY; exit 0; fi; done; echo TIMEOUT; exit 1'
    )
    if (pollResult.status !== 0 || !pollResult.stdout.includes('READY')) {
      throw new Error(`CLIProxyAPI failed to start on port 8317 on sandbox ${ip}. Check /tmp/cliproxyapi.log`)
    }
  }

  async unlink(opts: UnlinkOptions): Promise<void> {
    const { sandbox } = opts
    if (!sandbox) {
      throw new Error('AnthropicAdapter.unlink requires opts.sandbox (ip + keyPath)')
    }
    const { ip, keyPath } = sandbox

    // Fail-fast: test SSH first
    const connectResult = runSsh(this.spawnSync, ip, keyPath, 'echo ok')
    if (connectResult.status !== 0) {
      throw new SandboxUnreachableError(ip)
    }

    // Remove auth file
    runSsh(this.spawnSync, ip, keyPath, 'rm -f ~/CLIProxyAPI/auths/user.json')

    // Remove config.yaml (contains claude-api-key with credential)
    runSsh(this.spawnSync, ip, keyPath, 'rm -f ~/CLIProxyAPI/config.yaml')

    // Stop CLIProxyAPI — use fuser to kill by port rather than pattern-matching on
    // the command name, which could match the SSH session's bash process and kill it.
    runSsh(this.spawnSync, ip, keyPath, 'fuser -k 8317/tcp 2>/dev/null || true')
  }
}
