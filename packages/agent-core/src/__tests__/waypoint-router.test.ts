import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

// Mock child_process to avoid spawning real SSH
vi.mock('node:child_process')
import { spawnSync } from 'node:child_process'

// Mock node:fs so the token-refresh path does not read the real user's
// ~/.config/duoidal/token.json during tests. Default: no local token present,
// so routeToServer behaves deterministically across machines. Individual tests
// override fs.existsSync / fs.readFileSync to exercise the push code path.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const existsSync = vi.fn(() => false)
  const readFileSync = vi.fn(actual.readFileSync)
  return {
    ...actual,
    default: { ...actual, existsSync, readFileSync },
    existsSync,
    readFileSync,
  }
})
import fs from 'node:fs'

import { routeToServer } from '../lib/waypoint-router.js'
import type { DispatchConfig } from '../lib/dispatch-config.js'

const TOKEN_PATH = path.join(os.homedir(), '.config', 'duoidal', 'token.json')

let savedAnthropicBaseUrl: string | undefined

beforeEach(() => {
  // Clear ANTHROPIC_BASE_URL so tests don't trigger the curl public-IP lookup
  savedAnthropicBaseUrl = process.env['ANTHROPIC_BASE_URL']
  delete process.env['ANTHROPIC_BASE_URL']
  // Default: no local token — existing tests assume no token-refresh SSH call
  // fires. Token-refresh tests override these mocks explicitly.
  vi.mocked(fs.existsSync).mockReturnValue(false)
})

afterEach(() => {
  vi.resetAllMocks()
  if (savedAnthropicBaseUrl !== undefined) {
    process.env['ANTHROPIC_BASE_URL'] = savedAnthropicBaseUrl
  }
})

const SELF_CONFIG: DispatchConfig = { server: 'self' }

const NAMED_CONFIG: DispatchConfig = {
  server: 'openclaw',
  servers: {
    openclaw: { host: 'openclaw.example.com', user: 'ubuntu', key: '~/.ssh/id_rsa' },
  },
}

// Valid UUIDs for tests
const SKILL_UUID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff'
const SKILL_UUID_2 = '11112222-3333-4444-5555-666677778888'
const SKILL_UUID_3 = '99990000-aaaa-bbbb-cccc-ddddeeeeeeee'

// ---------------------------------------------------------------------------
// 1. server: self → local short-circuit, no SSH
// ---------------------------------------------------------------------------

describe('routeToServer — server: self', () => {
  it('returns { local: true } without calling spawnSync', () => {
    const result = routeToServer(SELF_CONFIG, SKILL_UUID, 3)
    expect(result).toEqual({ local: true })
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2. hopCount guard
// ---------------------------------------------------------------------------

describe('routeToServer — hop depth guard', () => {
  it('throws when hopCount is 6 (exceeds maximum)', () => {
    expect(() => routeToServer(SELF_CONFIG, SKILL_UUID, 3, { hopCount: 6 }))
      .toThrow('exceeded maximum depth')
  })

  it('does NOT throw when hopCount is exactly 5 (boundary allowed)', () => {
    expect(() => routeToServer(SELF_CONFIG, SKILL_UUID, 3, { hopCount: 5 }))
      .not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. Named server → SSH spawned with correct args
// ---------------------------------------------------------------------------

describe('routeToServer — named server SSH dispatch', () => {
  it('calls spawnSync with ssh, correct host/user/key and skill-resource-id in command', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = routeToServer(NAMED_CONFIG, SKILL_UUID_2, 2, { hopCount: 1 })

    expect(result).toEqual({ local: false })
    expect(vi.mocked(spawnSync)).toHaveBeenCalledOnce()

    const call = vi.mocked(spawnSync).mock.calls[0]!
    const cmd = call[0] as string
    const args = call[1] as string[]
    expect(cmd).toBe('ssh')
    expect(args).toContain('-i')
    expect(args).toContain('~/.ssh/id_rsa')
    // '--' separator must appear before destination (options injection guard)
    const dashDashIdx = args.indexOf('--')
    expect(dashDashIdx).toBeGreaterThan(-1)
    expect(args[dashDashIdx + 1]).toBe('ubuntu@openclaw.example.com')

    const remoteCmd = args[args.length - 1] as string
    expect(remoteCmd).toContain(`--skill-resource-id ${SKILL_UUID_2}`)
    expect(remoteCmd).toContain('--epochs 2')
    expect(remoteCmd).toContain('--hops 2')
  })

  it('throws when spawnSync returns a spawn error', () => {
    vi.mocked(spawnSync).mockReturnValue({ error: new Error('ENOENT') } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(NAMED_CONFIG, SKILL_UUID_2, 2))
      .toThrow('SSH to openclaw failed to spawn: ENOENT')
  })

  it('throws when spawnSync returns non-zero exit code', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 255 } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(NAMED_CONFIG, SKILL_UUID_2, 2))
      .toThrow('SSH to openclaw exited with code 255')
  })
})

// ---------------------------------------------------------------------------
// 4. Named server missing from config.servers → throws
// ---------------------------------------------------------------------------

describe('routeToServer — missing server config', () => {
  it('throws when named server is absent from config.servers', () => {
    const config: DispatchConfig = { server: 'ghost' }
    expect(() => routeToServer(config, SKILL_UUID_3, 1))
      .toThrow('not found in config.servers')
  })

  it('includes the server name in the error message', () => {
    const config: DispatchConfig = { server: 'ghost' }
    expect(() => routeToServer(config, SKILL_UUID_3, 1))
      .toThrow("Server 'ghost' not found in config.servers")
  })
})

// ---------------------------------------------------------------------------
// 5. unlinked: true → --unlinked flag in SSH command
// ---------------------------------------------------------------------------

describe('routeToServer — unlinked flag', () => {
  it('includes --unlinked in the remote command when opts.unlinked is true', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(NAMED_CONFIG, SKILL_UUID_3, 4, { hopCount: 0, unlinked: true })

    const call1 = vi.mocked(spawnSync).mock.calls[0]!
    const args1 = call1[1] as string[]
    const remoteCmd1 = args1[args1.length - 1] as string
    expect(remoteCmd1).toContain('--unlinked')
  })

  it('does NOT include --unlinked when opts.unlinked is false', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(NAMED_CONFIG, SKILL_UUID_3, 4, { hopCount: 0, unlinked: false })

    const call2 = vi.mocked(spawnSync).mock.calls[0]!
    const args2 = call2[1] as string[]
    const remoteCmd2 = args2[args2.length - 1] as string
    expect(remoteCmd2).not.toContain('--unlinked')
  })
})

// ---------------------------------------------------------------------------
// 5b. pr flag forwarding — caller's --pr/--no-pr choice must reach the remote
// ---------------------------------------------------------------------------

describe('routeToServer — pr flag forwarding', () => {
  it('forwards --no-pr to the remote when opts.pr is false', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(NAMED_CONFIG, SKILL_UUID_3, 4, { hopCount: 0, pr: false })

    const call = vi.mocked(spawnSync).mock.calls[0]!
    const args = call[1] as string[]
    const remoteCmd = args[args.length - 1] as string
    expect(remoteCmd).toContain('--no-pr')
    expect(remoteCmd).not.toContain('--pr')
  })

  it('forwards --pr to the remote when opts.pr is true', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(NAMED_CONFIG, SKILL_UUID_3, 4, { hopCount: 0, pr: true })

    const call = vi.mocked(spawnSync).mock.calls[0]!
    const args = call[1] as string[]
    const remoteCmd = args[args.length - 1] as string
    expect(remoteCmd).toContain('--pr')
    expect(remoteCmd).not.toContain('--no-pr')
  })

  it('does NOT include --pr or --no-pr when opts.pr is omitted (let remote default apply)', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(NAMED_CONFIG, SKILL_UUID_3, 4, { hopCount: 0 })

    const call = vi.mocked(spawnSync).mock.calls[0]!
    const args = call[1] as string[]
    const remoteCmd = args[args.length - 1] as string
    expect(remoteCmd).not.toContain('--pr')
    expect(remoteCmd).not.toContain('--no-pr')
  })
})

// ---------------------------------------------------------------------------
// 6. Input validation guards
// ---------------------------------------------------------------------------

describe('routeToServer — input validation', () => {
  it('throws when skillResourceId is not a valid UUID', () => {
    expect(() => routeToServer(SELF_CONFIG, 'not-a-uuid', 3))
      .toThrow('invalid skillResourceId')
  })

  it('throws when epochs is not a positive integer', () => {
    expect(() => routeToServer(SELF_CONFIG, SKILL_UUID, 0))
      .toThrow('invalid epochs')
  })

  it('throws when epochs is NaN', () => {
    expect(() => routeToServer(SELF_CONFIG, SKILL_UUID, NaN))
      .toThrow('invalid epochs')
  })
})

// ---------------------------------------------------------------------------
// 7. SSH options injection guard — host/user/key starting with '-'
// ---------------------------------------------------------------------------

describe('routeToServer — SSH options injection guard', () => {
  it('throws when host starts with "-"', () => {
    const config: DispatchConfig = {
      server: 'bad',
      servers: { bad: { host: '-oProxyCommand=evil', user: 'ubuntu', key: '/root/.ssh/id_rsa' } },
    }
    expect(() => routeToServer(config, SKILL_UUID, 3))
      .toThrow("must not start with '-'")
  })

  it('throws when user starts with "-"', () => {
    const config: DispatchConfig = {
      server: 'bad',
      servers: { bad: { host: 'example.com', user: '-l', key: '/root/.ssh/id_rsa' } },
    }
    expect(() => routeToServer(config, SKILL_UUID, 3))
      .toThrow("must not start with '-'")
  })

  it('throws when key starts with "-"', () => {
    const config: DispatchConfig = {
      server: 'bad',
      servers: { bad: { host: 'example.com', user: 'ubuntu', key: '-rw-r--r--' } },
    }
    expect(() => routeToServer(config, SKILL_UUID, 3))
      .toThrow("must not start with '-'")
  })
})

// ---------------------------------------------------------------------------
// 8. Pre-flight container health probe (docker-exec dispatch)
// ---------------------------------------------------------------------------

const CONTAINER_CONFIG: DispatchConfig = {
  server: 'openclaw',
  servers: {
    openclaw: {
      host: 'openclaw.example.com',
      user: 'root',
      key: '~/.ssh/id_rsa',
      container: 'runtime-runtime-1',
    },
  },
}

// Helper: prime a mock local token for pre-flight tests that need to reach the
// dispatch step. Without a local token the new refreshContainerToken throws
// immediately — container probe tests that validate the probe itself, not the
// token flow, must supply a token so execution reaches the dispatch call.
function primeContainerToken(content = JSON.stringify({ access_token: 'mock', refresh_token: 'mock-r' })): void {
  const tokenPath = path.join(os.homedir(), '.config', 'duoidal', 'token.json')
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => String(p) === tokenPath)
  vi.mocked(fs.readFileSync).mockImplementation(((p: fs.PathOrFileDescriptor, _opts?: unknown) => {
    if (String(p) === tokenPath) return content
    throw new Error(`unexpected readFileSync(${String(p)}) in test`)
  }) as typeof fs.readFileSync)
}

describe('routeToServer — container pre-flight probe', () => {
  it('runs the probe with matching SSH flags (-i <key>, StrictHostKeyChecking=accept-new, "--") before dispatch', () => {
    // Prime a token so execution proceeds past refreshContainerToken to dispatch.
    primeContainerToken()
    // call order: probe (success) → token push (success) → token validate (success) → dispatch (success)
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1)
    expect(result).toEqual({ local: false })
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(4)

    const probeCall = vi.mocked(spawnSync).mock.calls[0]!
    const probeCmd = probeCall[0] as string
    const probeArgs = probeCall[1] as string[]
    expect(probeCmd).toBe('ssh')
    expect(probeArgs).toContain('-i')
    expect(probeArgs).toContain('~/.ssh/id_rsa')
    expect(probeArgs).toContain('StrictHostKeyChecking=accept-new')
    const dashDashIdx = probeArgs.indexOf('--')
    expect(dashDashIdx).toBeGreaterThan(-1)
    expect(probeArgs[dashDashIdx + 1]).toBe('root@openclaw.example.com')
    const probeRemote = probeArgs[probeArgs.length - 1] as string
    expect(probeRemote).toContain(`docker exec runtime-runtime-1`)
    expect(probeRemote).toContain('duoidal --version')
    // Probe should also verify node and npx to catch mid-boot containers
    expect(probeRemote).toContain('command -v node')
    expect(probeRemote).toContain('command -v npx')
    expect(probeRemote).toContain('command -v duoidal')
    // Probe must emit a preflight marker so the caller can distinguish which
    // tool was missing rather than seeing only "exit 127".
    expect(probeRemote).toContain('preflight:')
    // Probe must honor the 15s timeout to avoid hanging callers
    const probeOptions = probeCall[2] as { timeout?: number; encoding?: BufferEncoding }
    expect(probeOptions.timeout).toBeLessThanOrEqual(15_000)
    expect(probeOptions.encoding).toBe('utf8')
  })

  it('returns the normal remote command when probe exits 0', () => {
    // Prime a token so execution proceeds past refreshContainerToken to dispatch.
    primeContainerToken()
    // call order: probe → push → validate → dispatch
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1)
    expect(result).toEqual({ local: false })

    // Dispatch is the 4th call (index 3)
    const dispatchCall = vi.mocked(spawnSync).mock.calls[3]!
    const dispatchArgs = dispatchCall[1] as string[]
    const dispatchRemote = dispatchArgs[dispatchArgs.length - 1] as string
    expect(dispatchRemote).toContain('docker exec')
    expect(dispatchRemote).toContain('runtime-runtime-1')
    expect(dispatchRemote).toContain(`--skill-resource-id ${SKILL_UUID}`)
  })

  it('throws a clear, actionable error when probe exits non-zero — no dispatch attempted', () => {
    // Probe fails with the real cryptic error this feature is designed to catch
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 127,
      stdout: '',
      stderr: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "duoidal": executable file not found in $PATH\n',
    } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/Pre-flight check failed: duoidal not runnable inside container 'runtime-runtime-1'/)

    // Only the probe ran — no dispatch should have been attempted after the failure
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1)
  })

  it('error message includes remediation instructions', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 127,
      stdout: '',
      stderr: 'exec: "duoidal": executable file not found in $PATH\n',
    } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/Remediation:.*docker compose down.*docker compose up -d/)
  })

  it('error message surfaces the underlying stderr detail for diagnosis', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 127,
      stdout: '',
      stderr: 'OCI runtime exec failed: some-specific-failure-text\n',
    } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/some-specific-failure-text/)
  })

  it('does NOT probe when server config has no container (direct-SSH mode)', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(NAMED_CONFIG, SKILL_UUID, 1)

    // Only the dispatch SSH call — no extra probe call
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1)
    const onlyCall = vi.mocked(spawnSync).mock.calls[0]!
    const remote = (onlyCall[1] as string[]).slice(-1)[0] as string
    // The single call is the dispatch itself (no docker exec wrapper)
    expect(remote).not.toContain('docker exec')
  })

  it('does NOT probe when config.server is "self" (local tmux path)', () => {
    const result = routeToServer(SELF_CONFIG, SKILL_UUID, 1)
    expect(result).toEqual({ local: true })
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 9. Idempotent auth-token refresh and post-push validation into remote container
// ---------------------------------------------------------------------------

describe('routeToServer — container token refresh', () => {
  const MOCK_TOKEN = JSON.stringify({
    access_token: 'eyJhbGciOiJIUzI1NiJ9.mockbody.mocksig',
    refresh_token: 'mock-refresh-token',
  })

  function primeLocalToken(content = MOCK_TOKEN): void {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p) === TOKEN_PATH
    })
    vi.mocked(fs.readFileSync).mockImplementation(((p: fs.PathOrFileDescriptor, _opts?: unknown) => {
      if (String(p) === TOKEN_PATH) return content
      throw new Error(`unexpected readFileSync(${String(p)}) in test`)
    }) as typeof fs.readFileSync)
  }

  it('pushes the local token into the container before dispatching when the token exists', () => {
    primeLocalToken()
    // call order: probe (success) → token push (success) → token validate (success) → dispatch (success)
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1)
    expect(result).toEqual({ local: false })
    // 4 SSH calls: probe + push + validate + dispatch
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(4)

    const pushCall = vi.mocked(spawnSync).mock.calls[1]!
    const pushCmd = pushCall[0] as string
    const pushArgs = pushCall[1] as string[]
    const pushOpts = pushCall[2] as { input?: string; timeout?: number; encoding?: string }

    // Correct SSH transport
    expect(pushCmd).toBe('ssh')
    expect(pushArgs).toContain('-i')
    expect(pushArgs).toContain('~/.ssh/id_rsa')
    expect(pushArgs).toContain('StrictHostKeyChecking=accept-new')
    const dashDashIdx = pushArgs.indexOf('--')
    expect(dashDashIdx).toBeGreaterThan(-1)
    expect(pushArgs[dashDashIdx + 1]).toBe('root@openclaw.example.com')

    // Token bytes must travel over stdin, NOT be interpolated into the command
    // string or into an env flag. `input` is how spawnSync streams stdin —
    // this is the security-critical assertion.
    expect(pushOpts.input).toBe(MOCK_TOKEN)

    // Remote command: writes to /root/.config/duoidal/token.json via stdin
    // heredoc, chmods 600, never materializes the token on the host.
    const pushRemote = pushArgs[pushArgs.length - 1] as string
    expect(pushRemote).toContain('docker exec -i runtime-runtime-1')
    expect(pushRemote).toContain('mkdir -p /root/.config/duoidal')
    expect(pushRemote).toContain('cat > /root/.config/duoidal/token.json')
    expect(pushRemote).toContain('chmod 600 /root/.config/duoidal/token.json')
    // Token content must NOT appear in the remote command string
    expect(pushRemote).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(pushRemote).not.toContain('mock-refresh-token')

    // Short timeout so a flaky SSH cannot hang the dispatch flow
    expect(pushOpts.timeout).toBeLessThanOrEqual(20_000)
    expect(pushOpts.encoding).toBe('utf8')
  })

  it('runs duoidal auth whoami inside the container after a successful push (post-push validation)', () => {
    primeLocalToken()
    // call order: probe → push → validate → dispatch
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: 'user-refresh-789\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1)
    expect(result).toEqual({ local: false })
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(4)

    // The 3rd call (index 2) must be the auth-whoami validation
    const validateCall = vi.mocked(spawnSync).mock.calls[2]!
    const validateArgs = validateCall[1] as string[]
    const validateOpts = validateCall[2] as { timeout?: number; encoding?: string }
    const validateRemote = validateArgs[validateArgs.length - 1] as string
    expect(validateRemote).toContain('docker exec runtime-runtime-1')
    expect(validateRemote).toContain('duoidal auth whoami')
    // Must not use -i (no stdin needed for read-only check)
    expect(validateRemote).not.toContain('docker exec -i')
    // Hard 5s timeout so a hung container cannot stall dispatch indefinitely
    expect(validateOpts.timeout).toBeLessThanOrEqual(5_000)
    expect(validateOpts.encoding).toBe('utf8')
  })

  it('throws when the token-push SSH exits non-zero — fails fast, does not attempt dispatch', () => {
    primeLocalToken()
    // Probe success → token push FAILS → should throw, no dispatch
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'docker exec: container not running\n',
      } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/Token push to container 'runtime-runtime-1' failed/)

    // Only probe + push ran — no validate or dispatch after the push failure
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(2)
  })

  it('error on push failure includes token path and auth failure reason', () => {
    primeLocalToken()
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'docker exec: container not running\n',
      } as ReturnType<typeof spawnSync>)

    let caughtError: Error | null = null
    try {
      routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1)
    } catch (err) {
      caughtError = err as Error
    }
    expect(caughtError).not.toBeNull()
    expect(caughtError?.message).toMatch(/\/root\/.config\/duoidal\/token\.json/)
    expect(caughtError?.message).toMatch(/docker exec: container not running/)
  })

  it('throws when post-push auth validation fails — fails fast, does not attempt dispatch', () => {
    primeLocalToken()
    // Probe success → push success → validate FAILS → should throw, no dispatch
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'token expired or invalid\n',
      } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/Token push to container 'runtime-runtime-1' succeeded but auth validation failed/)

    // Only probe + push + validate ran — dispatch was NOT attempted
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(3)
  })

  it('auth validation failure error includes token path and auth failure reason', () => {
    primeLocalToken()
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'token expired or invalid\n',
      } as ReturnType<typeof spawnSync>)

    let caughtError: Error | null = null
    try {
      routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1)
    } catch (err) {
      caughtError = err as Error
    }
    expect(caughtError).not.toBeNull()
    expect(caughtError?.message).toMatch(/\/root\/.config\/duoidal\/token\.json/)
    expect(caughtError?.message).toMatch(/token expired or invalid/)
  })

  it('auth validation failure error includes remediation instructions', () => {
    primeLocalToken()
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Not authenticated\n',
      } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/duoidal auth refresh/)
  })

  it('throws with clear error when the local token file is missing — fails fast within 5s (negative test)', () => {
    // Default beforeEach state: fs.existsSync returns false — no local token.
    // Prime the probe so it succeeds; the missing-token error must fire immediately
    // after, before any dispatch attempt.
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/Token push to container 'runtime-runtime-1' failed: no local token found/)

    // Only the probe ran — no push, validate, or dispatch after the missing-token failure
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1)
  })

  it('missing-token error includes token path in the error message', () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/\/root\/.config\/duoidal\/token\.json/)
  })

  it('missing-token error includes auth failure reason in the error message', () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)

    expect(() => routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1))
      .toThrow(/local token file missing/)
  })

  it('does NOT push when dispatch path has no container (direct-SSH mode)', () => {
    primeLocalToken()
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(NAMED_CONFIG, SKILL_UUID, 1)

    // Exactly one SSH call: the dispatch itself. No probe (no container)
    // and no token push (token refresh is container-only).
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1)
  })

  it('does NOT push when config.server is "self" (local tmux path)', () => {
    primeLocalToken()
    const result = routeToServer(SELF_CONFIG, SKILL_UUID, 1)
    expect(result).toEqual({ local: true })
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled()
  })
})

// 9. DUOIDAL_RUN_TYPE threading — remote docker-exec dispatch must forward the
//    originating server name so the nested `duoidal execute` inside the
//    container records `run_type = 'cloud'` instead of defaulting to 'local'.
// ---------------------------------------------------------------------------

describe('routeToServer — DUOIDAL_RUN_TYPE env forwarding', () => {
  it('forwards DUOIDAL_RUN_TYPE=<server-name> as a docker -e flag on the container path', () => {
    // Prime a local token so execution proceeds past refreshContainerToken to dispatch.
    primeContainerToken()
    // call order: probe → push → validate → dispatch (index 3)
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(CONTAINER_CONFIG, SKILL_UUID, 1)

    // 4th call (index 3) = the actual dispatch
    const dispatchCall = vi.mocked(spawnSync).mock.calls[3]!
    const dispatchArgs = dispatchCall[1] as string[]
    const dispatchRemote = dispatchArgs[dispatchArgs.length - 1] as string

    expect(dispatchRemote).toContain('docker exec')
    // -e DUOIDAL_RUN_TYPE=<shell-quoted server name> must appear before the container ID.
    // CONTAINER_CONFIG.server === 'openclaw', so the value is single-quoted 'openclaw'.
    expect(dispatchRemote).toContain(`-e DUOIDAL_RUN_TYPE='openclaw'`)
  })

  it('shell-quotes the server name to prevent command injection', () => {
    // Hostile server name embedded in config (defensive — user could type anything)
    const hostileConfig: DispatchConfig = {
      server: `foo'; rm -rf /`,
      servers: {
        [`foo'; rm -rf /`]: {
          host: 'example.com',
          user: 'root',
          key: '~/.ssh/id_rsa',
          container: 'runtime-runtime-1',
        },
      },
    }
    // Prime a local token so execution proceeds past refreshContainerToken to dispatch.
    primeContainerToken()
    // call order: probe → push → validate → dispatch (index 3)
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'duoidal 1.2.3\n', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(hostileConfig, SKILL_UUID, 1)

    // 4th call (index 3) = the actual dispatch
    const dispatchCall = vi.mocked(spawnSync).mock.calls[3]!
    const dispatchArgs = dispatchCall[1] as string[]
    const dispatchRemote = dispatchArgs[dispatchArgs.length - 1] as string
    // The embedded single-quote must be escaped via the shellQuote pattern ('\'')
    // so it cannot break out of the quoted string to execute `rm -rf /`.
    expect(dispatchRemote).toContain(`-e DUOIDAL_RUN_TYPE='foo'\\''; rm -rf /'`)
  })

  it('does NOT forward DUOIDAL_RUN_TYPE when config.server is "self" (local path)', () => {
    // server: self returns early with { local: true }; no docker exec, no env var leak.
    const result = routeToServer(SELF_CONFIG, SKILL_UUID, 1)
    expect(result).toEqual({ local: true })
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled()
  })

  it('does NOT forward DUOIDAL_RUN_TYPE when the server has no container (direct-SSH mode)', () => {
    // Direct-SSH (no docker wrapper) is not the container path this bug targets;
    // the env var is only meaningful for the docker-exec hop, so leave it off.
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    routeToServer(NAMED_CONFIG, SKILL_UUID, 1)

    const onlyCall = vi.mocked(spawnSync).mock.calls[0]!
    const remote = (onlyCall[1] as string[]).slice(-1)[0] as string
    expect(remote).not.toContain('DUOIDAL_RUN_TYPE')
    expect(remote).not.toContain('docker exec')
  })
})

