import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// Resolve the project root relative to this test file:
// packages/duoidal-cli/src/__tests__/ → root is 4 levels up
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

// Top-level mock — hoisted before imports, so no variable references allowed in factory
vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>()
  return {
    ...actual,
    readToken: vi.fn(),
    writeSandboxKey: vi.fn(),
    getSandboxKeyPath: vi.fn().mockReturnValue('/home/user/.config/duoidal/sandboxes/srv-abc/id_ed25519'),
    getSandboxKeyPathByName: vi.fn().mockImplementation((name: string) => `/home/user/.duoidal/keys/${name}/id_ed25519`),
    writeSandboxKeyByName: vi.fn(),
  }
})

// Mock @duoidal/config so tests don't read/write real config files
vi.mock('@duoidal/config', () => {
  const readConfig = vi.fn().mockReturnValue({ server: 'self', servers: {} })
  const writeConfig = vi.fn()
  const resolveConfigPath = vi.fn().mockReturnValue(`${os.homedir()}/.duoidal/config.json`)
  return {
    readConfig,
    writeConfig,
    resolveConfigPath,
    getServer: vi.fn(),
  }
})

vi.mock('@duoidal/auth/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@duoidal/auth/adapters')>()
  return {
    ...actual,
    createAuthenticatedSupabaseClient: vi.fn(),
  }
})

// Mock node:child_process so execFileSync (ssh, scp) doesn't actually run
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(),
  }
})

// Mock BFF client module
vi.mock('../lib/sandbox-bff-client.js', () => {
  return {
    provisionSandbox: vi.fn(),
    deprovisionSandbox: vi.fn(),
    getSandboxStatus: vi.fn(),
    getSshAccess: vi.fn(),
    getRepoCloneUrl: vi.fn(),
    BffNotApprovedError: class BffNotApprovedError extends Error {
      constructor(message = 'Not approved: HTTP 403') {
        super(message)
        this.name = 'BffNotApprovedError'
      }
    },
    BffSandboxLimitError: class BffSandboxLimitError extends Error {
      constructor(message = 'Sandbox limit reached: HTTP 409') {
        super(message)
        this.name = 'BffSandboxLimitError'
      }
    },
    BffUnreachableError: class BffUnreachableError extends Error {
      constructor(message: string, cause?: unknown) {
        super(message)
        this.name = 'BffUnreachableError'
        if (cause !== undefined) (this as unknown as { cause: unknown }).cause = cause
      }
    },
    BffSandboxNotFoundError: class BffSandboxNotFoundError extends Error {
      constructor(message = 'Sandbox not found: HTTP 404') {
        super(message)
        this.name = 'BffSandboxNotFoundError'
      }
    },
  }
})

import { sandboxCommand } from '../commands/sandbox.js'
import type { ExecuteActionFn, SupabaseClientFactory } from '../commands/sandbox.js'
import * as config from '../lib/config.js'
import * as bffClient from '../lib/sandbox-bff-client.js'
import * as duoidalConfig from '@duoidal/config'
import { createAuthenticatedSupabaseClient } from '@duoidal/auth/adapters'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-sandbox-test-'))
  vi.mocked(config.readToken).mockReset()
  vi.mocked(config.writeSandboxKey).mockReset()
  vi.mocked(config.writeSandboxKeyByName).mockReset()
  vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: 'self', servers: {} })
  vi.mocked(duoidalConfig.writeConfig).mockReset()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A valid JWT with sub and email claims (not verified, just decoded)
function makeJwt(sub: string, email = 'user@example.com'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub, email, exp: 9999999999 })).toString('base64url')
  const sig = 'fake-sig'
  return `${header}.${payload}.${sig}`
}

function makeStoredToken(sub: string, email?: string) {
  return {
    access_token: makeJwt(sub, email),
    refresh_token: 'refresh-token',
  }
}

// Run a subcommand under `sandbox` with given args
async function runSandbox(args: string[]) {
  const cmd = sandboxCommand()
  cmd.exitOverride()
  // Also apply exitOverride to subcommands so they throw instead of process.exit
  for (const sub of cmd.commands) {
    sub.exitOverride()
  }
  return cmd.parseAsync(['node', 'duoidal', ...args])
}

// ---------------------------------------------------------------------------
// 1. --help output
// ---------------------------------------------------------------------------

describe('sandbox --help', () => {
  it('includes provision and status subcommands', () => {
    const cmd = sandboxCommand()
    const helpText = cmd.helpInformation()
    expect(helpText).toContain('provision')
    expect(helpText).toContain('status')
  })

  it('provision --help describes the command', () => {
    const cmd = sandboxCommand()
    const provisionCmd = cmd.commands.find(c => c.name() === 'provision')
    expect(provisionCmd).toBeDefined()
    const helpText = provisionCmd!.helpInformation()
    expect(helpText).toContain('Provision')
  })

  it('status --help describes the command', () => {
    const cmd = sandboxCommand()
    const statusCmd = cmd.commands.find(c => c.name() === 'status')
    expect(statusCmd).toBeDefined()
    const helpText = statusCmd!.helpInformation()
    expect(helpText).toContain('status')
  })
})

// ---------------------------------------------------------------------------
// 2. Not logged in path
// ---------------------------------------------------------------------------

describe('sandbox provision — not logged in', () => {
  it('prints error and exits when no token is stored', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runSandbox(['provision'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith('Not logged in. Run: duoidal auth login')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 3. Successful provision with mocked BFF client
// ---------------------------------------------------------------------------

describe('sandbox provision — success', () => {
  it('calls provisionSandbox with jwt and publicKey, stores key', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000001', 'user@example.com'))
    vi.stubEnv('WORKTREE_REPO', PROJECT_ROOT)

    const mockJwt = makeJwt('00000000-0000-4000-8000-000000000001', 'user@example.com')

    vi.mocked(bffClient.provisionSandbox).mockResolvedValue({ status: 'provisioning', resourceId: 'srv-abc' })
    vi.mocked(bffClient.getSandboxStatus).mockResolvedValue({ status: 'active', ip: '1.2.3.4' })
    // No existing entry in config
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: 'self', servers: {} })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runSandbox(['provision'])

    // provisionSandbox called with jwt and an ssh-ed25519 public key
    expect(bffClient.provisionSandbox).toHaveBeenCalledWith(
      mockJwt,
      expect.stringMatching(/^ssh-ed25519 /)
    )

    // Should have stored the private key in OpenSSH format by server name (via writeSandboxKeyByName)
    expect(config.writeSandboxKeyByName).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('-----BEGIN OPENSSH PRIVATE KEY-----'))

    // Should have logged the sandbox resource ID
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('srv-abc'))

    // Config should have been written
    expect(duoidalConfig.writeConfig).toHaveBeenCalled()
  })

  it('polls getSandboxStatus until active and reports ip', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('70d6d906-d7b4-4432-8b26-7358aff1d620'))
    vi.stubEnv('WORKTREE_REPO', PROJECT_ROOT)

    vi.mocked(bffClient.provisionSandbox).mockResolvedValue({ status: 'provisioning', resourceId: 'srv-poll' })
    // First two calls return provisioning, third returns active
    vi.mocked(bffClient.getSandboxStatus)
      .mockResolvedValueOnce({ status: 'provisioning' })
      .mockResolvedValueOnce({ status: 'provisioning' })
      .mockResolvedValue({ status: 'active', ip: '5.6.7.8' })

    // readConfig returns empty config (no existing server), then after writeConfig is called
    // it returns with the server written (simulate the first write then subsequent reads)
    vi.mocked(duoidalConfig.readConfig)
      .mockReturnValueOnce({ server: 'self', servers: {} })    // idempotency check
      .mockReturnValueOnce({ server: 'self', servers: {} })    // initial write
      .mockReturnValue({ server: 'srv-poll', servers: { 'srv-poll': { host: '', user: 'root', key: 'keys/srv-poll/id_ed25519', status: 'provisioning' } } }) // subsequent reads

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // Speed up polling by stubbing setTimeout
    vi.useFakeTimers()
    const runPromise = runSandbox(['provision'])
    // Drain microtasks and advance timers to skip polling delays
    await vi.runAllTimersAsync()
    await runPromise
    vi.useRealTimers()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('5.6.7.8'))
  })
})

// ---------------------------------------------------------------------------
// 4. BFF error handling during provision
// ---------------------------------------------------------------------------

describe('sandbox provision — BFF errors', () => {
  it('exits with "User not approved" on BffNotApprovedError', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('a049aa89-5cc0-4352-8ac0-212abd8e1c7a'))

    vi.mocked(bffClient.provisionSandbox).mockRejectedValue(
      new bffClient.BffNotApprovedError('Not approved: HTTP 403')
    )

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runSandbox(['provision'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith('User not approved')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('exits with "Sandbox limit reached" on BffSandboxLimitError', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('4d20ac6e-9058-438f-8a05-bb9519184c84'))

    vi.mocked(bffClient.provisionSandbox).mockRejectedValue(
      new bffClient.BffSandboxLimitError('Sandbox limit reached: HTTP 409')
    )

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runSandbox(['provision'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith('Sandbox limit reached')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('exits with "Could not reach provisioning service" on BffUnreachableError', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('134fca77-5307-452a-8411-9d8b40777764'))

    vi.mocked(bffClient.provisionSandbox).mockRejectedValue(
      new bffClient.BffUnreachableError('Cannot reach BFF')
    )

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runSandbox(['provision'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith('Could not reach provisioning service')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 5. sandbox status — no sandbox found
// ---------------------------------------------------------------------------

describe('sandbox status — no sandbox found', () => {
  it('prints error and exits when no sandbox in config and BFF unreachable', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('fcdf04d9-b61c-4ef4-8005-e940de681023'))
    // BFF unreachable + no local config → should error and exit
    vi.mocked(bffClient.getSandboxStatus).mockRejectedValue(new bffClient.BffUnreachableError('Cannot reach BFF'))
    // Config has no servers
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: 'self', servers: {} })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    // --id with a nonexistent id to trigger the "no metadata" path
    await expect(runSandbox(['status', '--id', 'nonexistent-sandbox-id'])).rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No sandbox found'))
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 6. sandbox status — with stored config entry
// ---------------------------------------------------------------------------

describe('sandbox status — with stored config entry', () => {
  it('displays sandbox info (BFF fallback to local config when unreachable)', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('bf0704a6-bf78-431d-8544-39f970878412'))
    // BFF unreachable — should fall back to local config
    vi.mocked(bffClient.getSandboxStatus).mockRejectedValue(new bffClient.BffUnreachableError('Cannot reach BFF'))

    const testResourceId = '11111111-2222-3333-4444-555555555555'
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'duoidal-testserver',
      servers: {
        'duoidal-testserver': {
          host: '',
          user: 'root',
          key: 'keys/duoidal-testserver/id_ed25519',
          resource_id: testResourceId,
          status: 'provisioning',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runSandbox(['status', '--id', testResourceId])

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(testResourceId))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('duoidal-testserver'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('provisioning'))
  })

  it('displays BFF status when reachable', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('52842e91-5d63-462c-800a-5a165c646145'))
    vi.mocked(bffClient.getSandboxStatus).mockResolvedValue({ status: 'active', ip: '10.0.0.1' })

    const testResourceId = '22222222-3333-4444-5555-666666666666'
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'duoidal-bff-status-test',
      servers: {
        'duoidal-bff-status-test': {
          host: '',
          user: 'root',
          key: 'keys/duoidal-bff-status-test/id_ed25519',
          resource_id: testResourceId,
          status: 'provisioning',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runSandbox(['status', '--id', testResourceId])

    // Should show BFF status (active) not local config status (provisioning)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('active'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('10.0.0.1'))
  })
})

// ---------------------------------------------------------------------------
// 7. sandbox ssh — help text
// ---------------------------------------------------------------------------

describe('sandbox ssh — help', () => {
  it('ssh --help shows usage', () => {
    const cmd = sandboxCommand()
    const sshCmd = cmd.commands.find(c => c.name() === 'ssh')
    expect(sshCmd).toBeDefined()
    const helpText = sshCmd!.helpInformation()
    expect(helpText).toContain('ssh')
  })
})

// ---------------------------------------------------------------------------
// 8. sandbox ssh — not logged in
// ---------------------------------------------------------------------------

describe('sandbox ssh — not logged in', () => {
  it('exits when no token', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)
    await expect(runSandbox(['ssh', '--dry-run'])).rejects.toThrow()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Not logged in'))
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 9. sandbox ssh — dry-run prints SSH command via BFF
// ---------------------------------------------------------------------------

describe('sandbox ssh — dry-run', () => {
  it('calls getSshAccess and prints SSH command without connecting', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('b2180bda-7549-481e-845c-7adcf5bf65c5'))
    vi.mocked(config.getSandboxKeyPathByName).mockReturnValue('/home/user/.duoidal/keys/duoidal-ssh-test/id_ed25519')

    vi.mocked(bffClient.getSshAccess).mockResolvedValue({
      allowed: true,
      ip: '1.2.3.4',
      keyPath: '/home/user/.duoidal/keys/duoidal-ssh-test/id_ed25519',
    })

    // Mock config with server entry
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'duoidal-ssh-test',
      servers: {
        'duoidal-ssh-test': {
          host: '1.2.3.4',
          user: 'root',
          key: 'keys/duoidal-ssh-test/id_ed25519',
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // Mock fs.existsSync to return true for the key path
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)

    await runSandbox(['ssh', '--name', 'duoidal-ssh-test', '--dry-run'])

    expect(bffClient.getSshAccess).toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ssh'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1.2.3.4'))
  })

  it('falls back to local config when BFF is unreachable', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('6f3e4e35-21c8-4cdc-86a2-bc05f79ad953'))
    vi.mocked(config.getSandboxKeyPathByName).mockReturnValue('/home/user/.duoidal/keys/duoidal-fallback-test/id_ed25519')

    vi.mocked(bffClient.getSshAccess).mockRejectedValue(
      new bffClient.BffUnreachableError('Cannot reach BFF')
    )

    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'duoidal-fallback-test',
      servers: {
        'duoidal-fallback-test': {
          host: '9.8.7.6',
          user: 'root',
          key: 'keys/duoidal-fallback-test/id_ed25519',
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)

    await runSandbox(['ssh', '--name', 'duoidal-fallback-test', '--dry-run'])

    // Should fall back to local config ip
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('9.8.7.6'))
  })

  it('falls back to local config when BFF returns 404 (sandbox not found in provisioning service)', async () => {
    // Covers the case where the BFF cannot find a sandbox provisioned via DB action,
    // or where BFF has a user-lookup mismatch (auth UUID vs email-local-part naming).
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('6561bc97-49df-4998-8f60-dcbbf65768ce'))
    vi.mocked(config.getSandboxKeyPathByName).mockReturnValue('/home/user/.duoidal/keys/duoidal-404-test/id_ed25519')

    vi.mocked(bffClient.getSshAccess).mockRejectedValue(
      new bffClient.BffSandboxNotFoundError('Sandbox not found: HTTP 404')
    )

    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'duoidal-404-test',
      servers: {
        'duoidal-404-test': {
          host: '10.20.30.40',
          user: 'root',
          key: 'keys/duoidal-404-test/id_ed25519',
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)

    await runSandbox(['ssh', '--name', 'duoidal-404-test', '--dry-run'])

    // Should fall back to local config ip when BFF returns 404
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('10.20.30.40'))
  })
})

// ---------------------------------------------------------------------------
// 10. sandbox deprovision — not logged in
// ---------------------------------------------------------------------------

describe('sandbox deprovision — not logged in', () => {
  it('exits with error when no token', async () => {
    vi.mocked(config.readToken).mockReturnValue(null)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)
    await expect(runSandbox(['deprovision', '--name', 'my-sandbox'])).rejects.toThrow()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Not logged in'))
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 11. sandbox deprovision — success
// ---------------------------------------------------------------------------

describe('sandbox deprovision — success', () => {
  it('calls deprovisionSandbox with jwt, removes config entry', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('77965639-f4aa-4432-8542-e5a288fdb4e3'))

    const serverResourceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    // Mock config with sandbox entry
    const mockConfig = {
      server: 'my-sandbox',
      servers: {
        'my-sandbox': {
          host: '1.2.3.4',
          user: 'root',
          key: 'keys/my-sandbox/id_ed25519',
          resource_id: serverResourceId,
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    vi.mocked(duoidalConfig.readConfig).mockReturnValue(JSON.parse(JSON.stringify(mockConfig)))

    vi.mocked(bffClient.deprovisionSandbox).mockResolvedValue({ deleted: true })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runSandbox(['deprovision', '--name', 'my-sandbox'])

    // BFF deprovision called with jwt only (server resolves sandbox from JWT sub)
    expect(bffClient.deprovisionSandbox).toHaveBeenCalledWith(
      makeJwt('77965639-f4aa-4432-8542-e5a288fdb4e3')
    )

    // Success message logged
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('successfully deprovisioned'))

    // writeConfig should have been called (to remove the entry)
    expect(duoidalConfig.writeConfig).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 12. sandbox deprovision — server not found locally
// ---------------------------------------------------------------------------

describe('sandbox deprovision — server not found', () => {
  it('exits with error when sandbox not found in config', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('67462baf-b1b0-4ade-8516-7a19092d2fa4'))
    // No servers in config
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: 'self', servers: {} })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)

    await expect(runSandbox(['deprovision', '--name', 'nonexistent-sandbox'])).rejects.toThrow()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No local sandbox found with name 'nonexistent-sandbox'"))
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 13. sandbox deprovision — BFF unreachable
// ---------------------------------------------------------------------------

describe('sandbox deprovision — BFF unreachable', () => {
  it('exits with "Could not reach provisioning service"', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('c8abb248-a0d3-4684-8414-d700b3118c47'))

    const serverResourceId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'unreachable-sandbox',
      servers: {
        'unreachable-sandbox': {
          host: '',
          user: 'root',
          key: 'keys/unreachable-sandbox/id_ed25519',
          resource_id: serverResourceId,
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    vi.mocked(bffClient.deprovisionSandbox).mockRejectedValue(
      new bffClient.BffUnreachableError('Cannot reach BFF')
    )

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)

    try {
      await expect(runSandbox(['deprovision', '--name', 'unreachable-sandbox'])).rejects.toThrow()

      expect(consoleSpy).toHaveBeenCalledWith('Could not reach provisioning service')
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      exitSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 14. sandbox repo-clone --help
// ---------------------------------------------------------------------------

describe('sandbox repo-clone --help', () => {
  it('shows --repo option', () => {
    const cmd = sandboxCommand()
    const sub = cmd.commands.find(c => c.name() === 'repo-clone')
    expect(sub).toBeDefined()
    const help = sub!.helpInformation()
    expect(help).toContain('--repo')
  })
})

// ---------------------------------------------------------------------------
// 15. sandbox dispatch --help
// ---------------------------------------------------------------------------

describe('sandbox dispatch --help', () => {
  it('shows --repo and --goal options', () => {
    const cmd = sandboxCommand()
    const sub = cmd.commands.find(c => c.name() === 'dispatch')
    expect(sub).toBeDefined()
    const help = sub!.helpInformation()
    expect(help).toContain('--repo')
    expect(help).toContain('--goal')
  })
})

// ---------------------------------------------------------------------------
// 16. sandbox repo-clone — BFF returns clone URL and SSH clone succeeds
// ---------------------------------------------------------------------------

describe('sandbox repo-clone — BFF success', () => {
  it('calls getRepoCloneUrl and clones repo via SSH', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000001'))

    vi.mocked(bffClient.getRepoCloneUrl).mockResolvedValue({
      cloneUrl: 'https://x-access-token:ghs_token123@github.com/myorg/myrepo.git',
    })
    vi.mocked(bffClient.getSshAccess).mockResolvedValue({
      allowed: true,
      ip: '1.2.3.4',
      keyPath: '/home/user/.duoidal/keys/my-sandbox/id_ed25519',
    })

    // Mock config with default server entry
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'my-sandbox',
      servers: {
        'my-sandbox': {
          host: '1.2.3.4',
          user: 'root',
          key: 'keys/my-sandbox/id_ed25519',
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const cmd = sandboxCommand()
    cmd.exitOverride()
    for (const sub of cmd.commands) sub.exitOverride()
    await cmd.parseAsync(['node', 'duodal', 'repo-clone', '--repo', 'myrepo'])

    expect(bffClient.getRepoCloneUrl).toHaveBeenCalledWith(expect.any(String), 'myrepo')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cloned'))
  })
})

// ---------------------------------------------------------------------------
// 17. sandbox repo-clone — BFF unreachable exits with error
// ---------------------------------------------------------------------------

describe('sandbox repo-clone — BFF unreachable', () => {
  it('exits with "Cannot reach provisioning service" when BFF is unreachable', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000002'))

    vi.mocked(bffClient.getRepoCloneUrl).mockRejectedValue(
      new bffClient.BffUnreachableError('Cannot reach provisioning service')
    )

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    const cmd = sandboxCommand()
    cmd.exitOverride()
    for (const sub of cmd.commands) sub.exitOverride()

    await expect(cmd.parseAsync(['node', 'duodal', 'repo-clone', '--repo', 'myrepo']))
      .rejects.toThrow('process.exit called')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot reach provisioning service'))
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 18. sandbox dispatch — nonexistent repo exits non-zero, no crash
// ---------------------------------------------------------------------------

describe('sandbox dispatch — nonexistent repo', () => {
  it('exits non-zero with error message, no stack trace', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('00000000-0000-4000-8000-000000000003'))
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')

    const mockClient = {
      auth: { setSession: vi.fn().mockResolvedValue({ data: {}, error: null }) },
      from: vi.fn().mockImplementation((_table: string) => {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [{ id: '2d598c47-bac9-4f82-8ce6-23c38d57a316', config: { repos: [] } }],
            error: null,
          }),
        }
      }),
    }
    vi.mocked(createAuthenticatedSupabaseClient).mockReturnValue(mockClient as any) // eslint-disable-line @typescript-eslint/no-explicit-any

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    const cmd = sandboxCommand()
    cmd.exitOverride()
    for (const sub of cmd.commands) sub.exitOverride()

    await expect(cmd.parseAsync(['node', 'duodal', 'dispatch', '--repo', 'nonexistent', '--goal', 'test']))
      .rejects.toThrow('process.exit called')

    // Should exit with non-zero (1) and a clean error message, not a stack trace
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'))
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 19. sandbox provision — stale cache detection
// ---------------------------------------------------------------------------

describe('sandbox provision — stale cache detection', () => {
  const staleResourceId = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa'

  it('exits non-zero with stale message when BFF reports non-active/provisioning status', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('743dc90b-6838-4bae-8d3d-79d2e4344c4a'))
    vi.stubEnv('WORKTREE_REPO', PROJECT_ROOT)

    // Config has the stale sandbox entry
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'stale-sandbox',
      servers: {
        'stale-sandbox': {
          host: '',
          user: 'root',
          key: 'keys/stale-sandbox/id_ed25519',
          resource_id: staleResourceId,
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    // BFF reports 'gone' status (not active/provisioning)
    vi.mocked(bffClient.getSandboxStatus).mockResolvedValue({ status: 'gone' })

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    try {
      await expect(runSandbox(['provision', '--name', 'stale-sandbox'])).rejects.toThrow('process.exit called')

      // Should exit with non-zero
      expect(exitSpy).toHaveBeenCalledWith(1)

      // Should mention 'stale' in the output
      const allErrors = consoleErrorSpy.mock.calls.map(c => c[0] as string).join('\n')
      expect(allErrors).toMatch(/stale/i)

      // provisionSandbox must NOT be called
      expect(bffClient.provisionSandbox).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('exits non-zero with stale/not-found-in-BFF message when BFF throws BffSandboxNotFoundError', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('8aaca3ff-2000-46d6-8545-279c958daa4f'))
    vi.stubEnv('WORKTREE_REPO', PROJECT_ROOT)

    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'stale-sandbox',
      servers: {
        'stale-sandbox': {
          host: '',
          user: 'root',
          key: 'keys/stale-sandbox/id_ed25519',
          resource_id: staleResourceId,
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    // BFF throws BffSandboxNotFoundError (HTTP 404)
    vi.mocked(bffClient.getSandboxStatus).mockRejectedValue(
      new bffClient.BffSandboxNotFoundError('Sandbox not found: HTTP 404')
    )

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    try {
      await expect(runSandbox(['provision', '--name', 'stale-sandbox'])).rejects.toThrow('process.exit called')

      // Should exit with non-zero
      expect(exitSpy).toHaveBeenCalledWith(1)

      // Should mention 'stale' or 'not found in BFF'
      const allErrors = consoleErrorSpy.mock.calls.map(c => c[0] as string).join('\n')
      expect(allErrors).toMatch(/stale|not found in BFF/i)

      // provisionSandbox must NOT be called
      expect(bffClient.provisionSandbox).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('with --force: removes stale config entry, provisions fresh sandbox, writes new config', async () => {
    vi.mocked(config.readToken).mockReturnValue(makeStoredToken('5d572452-b2da-4ea0-8f68-e076894ed0f7'))
    vi.stubEnv('WORKTREE_REPO', PROJECT_ROOT)

    const newResourceId = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb'

    // Config has the stale sandbox entry
    const staleConfig = {
      server: 'stale-sandbox',
      servers: {
        'stale-sandbox': {
          host: '',
          user: 'root',
          key: 'keys/stale-sandbox/id_ed25519',
          resource_id: staleResourceId,
          status: 'active',
          provisioned_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    vi.mocked(duoidalConfig.readConfig)
      .mockReturnValueOnce(JSON.parse(JSON.stringify(staleConfig)))  // idempotency check
      .mockReturnValueOnce(JSON.parse(JSON.stringify(staleConfig)))  // --force: read for delete
      .mockReturnValue({ server: 'stale-sandbox', servers: {} })     // after stale removed

    // First getSandboxStatus call (for stale check) throws BffSandboxNotFoundError
    // Second call (polling after provision) returns active
    vi.mocked(bffClient.getSandboxStatus)
      .mockRejectedValueOnce(new bffClient.BffSandboxNotFoundError('Sandbox not found: HTTP 404'))
      .mockResolvedValue({ status: 'active', ip: '10.0.0.1' })

    vi.mocked(bffClient.provisionSandbox).mockResolvedValue({ status: 'provisioning', resourceId: newResourceId })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runSandbox(['provision', '--name', 'stale-sandbox', '--force'])

    // provisionSandbox must have been called
    expect(bffClient.provisionSandbox).toHaveBeenCalled()

    // writeConfig should have been called (to remove stale entry and then write new one)
    expect(duoidalConfig.writeConfig).toHaveBeenCalled()

    // Output should mention the new resource ID
    const allLogs = consoleSpy.mock.calls.map(c => c[0] as string).join('\n')
    expect(allLogs).toContain(newResourceId)
  })
})
