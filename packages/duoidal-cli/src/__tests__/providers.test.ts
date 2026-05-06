import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SpawnSyncReturns } from 'node:child_process'
import { AnthropicAdapter } from '../providers/anthropic.js'
import { GitHubAdapter } from '../providers/github.js'
import { resolveProvider } from '../providers/index.js'
import { UnknownProviderError, SandboxUnreachableError, CLIProxyAPINotFoundError } from '../providers/types.js'
import type { SandboxConnection } from '../providers/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawnSyncResult(status: number, stdout = '', stderr = ''): SpawnSyncReturns<string> {
  return { status, stdout, stderr, pid: 1, output: [null, stdout, stderr], signal: null }
}

const mockSandbox: SandboxConnection = { ip: '1.2.3.4', keyPath: '/tmp/test-key' }

// ---------------------------------------------------------------------------
// resolveProvider
// ---------------------------------------------------------------------------

describe('resolveProvider', () => {
  it("returns AnthropicAdapter with provider='anthropic' and category='model'", () => {
    const adapter = resolveProvider('anthropic')
    expect(adapter).toBeInstanceOf(AnthropicAdapter)
    expect(adapter.provider).toBe('anthropic')
    expect(adapter.category).toBe('model')
  })

  it("returns GitHubAdapter with provider='github' and category='tool'", () => {
    const adapter = resolveProvider('github')
    expect(adapter).toBeInstanceOf(GitHubAdapter)
    expect(adapter.provider).toBe('github')
    expect(adapter.category).toBe('tool')
  })

  it("throws UnknownProviderError for 'unknown'", () => {
    expect(() => resolveProvider('unknown')).toThrow(UnknownProviderError)
    expect(() => resolveProvider('unknown')).toThrow(/unknown provider/i)
  })

  it("is case insensitive — 'ANTHROPIC' resolves to AnthropicAdapter", () => {
    const adapter = resolveProvider('ANTHROPIC')
    expect(adapter).toBeInstanceOf(AnthropicAdapter)
  })
})

// ---------------------------------------------------------------------------
// AnthropicAdapter.link
// ---------------------------------------------------------------------------

// Helper: returns 'READY' for the nc-based port-polling SSH command, 'ok' for everything else.
// The poll command is a shell loop containing 'seq 1 15' that exits with 'READY' on success.
function makeLinkMockSpawnSync(extraImpl?: (args: string[], opts?: { input?: string }) => void) {
  return vi.fn().mockImplementation((_cmd: string, args: string[], opts?: { input?: string }) => {
    extraImpl?.(args, opts)
    const command = args[args.length - 1] ?? ''
    if (command.includes('seq 1 15')) return makeSpawnSyncResult(0, 'READY')
    return makeSpawnSyncResult(0, 'ok')
  })
}

describe('AnthropicAdapter.link', () => {
  it('pipes auth JSON via stdin — credential NOT in SSH command args', async () => {
    const calls: Array<{ args: string[]; input?: string }> = []
    const mockSpawnSync = makeLinkMockSpawnSync((args, opts) => {
      calls.push({ args, input: opts?.input })
    })

    const adapter = new AnthropicAdapter(mockSpawnSync)
    const credential = 'sk-ant-secret-key-12345'
    await adapter.link({ credential, sandbox: mockSandbox })

    // Find the call that wrote the auth file (has JSON input)
    const authWriteCall = calls.find(c => c.input && c.input.includes('"access_token"'))
    expect(authWriteCall).toBeDefined()

    // Credential must NOT appear in SSH args
    for (const call of calls) {
      const argsStr = call.args.join(' ')
      expect(argsStr).not.toContain(credential)
    }
  })

  it('auth JSON contains correct fields with access_token, type=claude, disabled=false', async () => {
    let capturedAuthJson: Record<string, unknown> | undefined

    const mockSpawnSync = makeLinkMockSpawnSync((_args, opts) => {
      if (opts?.input && opts.input.includes('"access_token"')) {
        capturedAuthJson = JSON.parse(opts.input) as Record<string, unknown>
      }
    })

    const credential = 'sk-ant-my-key'
    const adapter = new AnthropicAdapter(mockSpawnSync)
    await adapter.link({ credential, sandbox: mockSandbox })

    expect(capturedAuthJson).toBeDefined()
    expect(capturedAuthJson!['access_token']).toBe(credential)
    expect(capturedAuthJson!['type']).toBe('claude')
    expect(capturedAuthJson!['disabled']).toBe(false)
    expect(capturedAuthJson!['email']).toBe('duoidal-user')
    expect(capturedAuthJson!['refresh_token']).toBe('')
  })

  it('auth JSON has expired as a future date and last_refresh as current date', async () => {
    let capturedAuthJson: Record<string, unknown> | undefined
    const before = new Date()

    const mockSpawnSync = makeLinkMockSpawnSync((_args, opts) => {
      if (opts?.input && opts.input.includes('"access_token"')) {
        capturedAuthJson = JSON.parse(opts.input) as Record<string, unknown>
      }
    })

    const adapter = new AnthropicAdapter(mockSpawnSync)
    await adapter.link({ credential: 'test-key', sandbox: mockSandbox })

    const after = new Date()
    expect(capturedAuthJson).toBeDefined()

    const lastRefresh = new Date(capturedAuthJson!['last_refresh'] as string)
    expect(lastRefresh.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(lastRefresh.getTime()).toBeLessThanOrEqual(after.getTime())

    const expired = new Date(capturedAuthJson!['expired'] as string)
    // expired should be approximately 1 year from now
    const oneYearFromNow = new Date()
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1)
    // Allow 5 seconds of slack
    expect(Math.abs(expired.getTime() - oneYearFromNow.getTime())).toBeLessThan(5000)
  })

  it('throws CLIProxyAPINotFoundError when test -f ~/CLIProxyAPI/cli-proxy-api fails', async () => {
    let callCount = 0
    const mockSpawnSync = vi.fn().mockImplementation(() => {
      callCount++
      // First call: echo ok (connectivity) → success
      // Second call: test -f ~/CLIProxyAPI/cli-proxy-api → failure
      return makeSpawnSyncResult(callCount === 1 ? 0 : 1)
    })

    const adapter = new AnthropicAdapter(mockSpawnSync)
    await expect(adapter.link({ credential: 'key', sandbox: mockSandbox }))
      .rejects.toThrow(CLIProxyAPINotFoundError)
  })

  it('throws SandboxUnreachableError when SSH connectivity check fails on link', async () => {
    const mockSpawnSync = vi.fn().mockReturnValue(makeSpawnSyncResult(1, '', 'Connection refused'))

    const adapter = new AnthropicAdapter(mockSpawnSync)
    await expect(adapter.link({ credential: 'key', sandbox: mockSandbox }))
      .rejects.toThrow(SandboxUnreachableError)
  })

  it('throws when sandbox is not provided', async () => {
    const adapter = new AnthropicAdapter(vi.fn())
    await expect(adapter.link({ credential: 'key' }))
      .rejects.toThrow(/requires opts\.sandbox/)
  })
})

// ---------------------------------------------------------------------------
// AnthropicAdapter.unlink
// ---------------------------------------------------------------------------

describe('AnthropicAdapter.unlink', () => {
  it('throws SandboxUnreachableError when SSH connectivity check fails', async () => {
    const mockSpawnSync = vi.fn().mockReturnValue(makeSpawnSyncResult(1, '', 'Connection refused'))

    const adapter = new AnthropicAdapter(mockSpawnSync)
    await expect(adapter.unlink({ sandbox: mockSandbox }))
      .rejects.toThrow(SandboxUnreachableError)
  })

  it('calls rm -f and pkill on success', async () => {
    const commands: string[] = []
    const mockSpawnSync = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      // Last element of args is the remote command
      commands.push(args[args.length - 1] ?? '')
      return makeSpawnSyncResult(0, 'ok')
    })

    const adapter = new AnthropicAdapter(mockSpawnSync)
    await adapter.unlink({ sandbox: mockSandbox })

    const allCommands = commands.join('\n')
    expect(allCommands).toContain('rm -f ~/CLIProxyAPI/auths/user.json')
    expect(allCommands).toContain('fuser -k 8317/tcp')
  })

  it('throws when sandbox is not provided', async () => {
    const adapter = new AnthropicAdapter(vi.fn())
    await expect(adapter.unlink({}))
      .rejects.toThrow(/requires opts\.sandbox/)
  })
})

// ---------------------------------------------------------------------------
// GitHubAdapter.link
// ---------------------------------------------------------------------------

describe('GitHubAdapter.link', () => {
  it('calls store_github_installation with userResourceId and installationId', async () => {
    const mockExecuteAction = vi.fn().mockResolvedValue({ success: true })
    const mockClient = {}

    const adapter = new GitHubAdapter()
    await adapter.link({
      credential: 'gh-installation-123',
      userResourceId: 'e46b5e28-c4bc-4b32-89d3-b20a51f1ddf9',
      sandboxName: 'my-sandbox',
      executeAction: mockExecuteAction,
      supabaseClient: mockClient,
    })

    expect(mockExecuteAction).toHaveBeenCalledWith(
      'store_github_installation',
      {
        userResourceId: 'e46b5e28-c4bc-4b32-89d3-b20a51f1ddf9',
        installationId: 'gh-installation-123',
        sandboxName: 'my-sandbox',
        provider: 'github',
      },
      mockClient
    )
  })

  it('throws when userResourceId is missing', async () => {
    const adapter = new GitHubAdapter()
    await expect(adapter.link({
      credential: 'gh-123',
      executeAction: vi.fn(),
      supabaseClient: {},
    })).rejects.toThrow(/userResourceId/)
  })

  it('throws when executeAction is missing', async () => {
    const adapter = new GitHubAdapter()
    await expect(adapter.link({
      credential: 'gh-123',
      userResourceId: 'bb85c3c5-6fa4-4d0b-869c-636e80aa0975',
      supabaseClient: {},
    })).rejects.toThrow(/executeAction/)
  })

  it('throws when supabaseClient is missing', async () => {
    const adapter = new GitHubAdapter()
    await expect(adapter.link({
      credential: 'gh-123',
      userResourceId: 'bb85c3c5-6fa4-4d0b-869c-636e80aa0975',
      executeAction: vi.fn(),
    })).rejects.toThrow(/supabaseClient/)
  })
})

// ---------------------------------------------------------------------------
// GitHubAdapter.unlink
// ---------------------------------------------------------------------------

describe('GitHubAdapter.unlink', () => {
  it('calls delete_user_credential action with credentialResourceId', async () => {
    const mockExecuteAction = vi.fn().mockResolvedValue({})
    const mockClient = {}

    const adapter = new GitHubAdapter()
    await adapter.unlink({
      credentialResourceId: 'cred-res-xyz',
      executeAction: mockExecuteAction,
      supabaseClient: mockClient,
    })

    expect(mockExecuteAction).toHaveBeenCalledWith(
      'delete_user_credential',
      { credentialResourceId: 'cred-res-xyz' },
      mockClient
    )
  })

  it('throws when credentialResourceId is missing', async () => {
    const adapter = new GitHubAdapter()
    await expect(adapter.unlink({ supabaseClient: {}, executeAction: vi.fn() }))
      .rejects.toThrow(/credentialResourceId/)
  })

  it('throws when executeAction is missing', async () => {
    const adapter = new GitHubAdapter()
    await expect(adapter.unlink({ credentialResourceId: 'cred-xyz', supabaseClient: {} }))
      .rejects.toThrow(/executeAction/)
  })

  it('throws when supabaseClient is missing', async () => {
    const adapter = new GitHubAdapter()
    await expect(adapter.unlink({ credentialResourceId: 'cred-xyz', executeAction: vi.fn() }))
      .rejects.toThrow(/supabaseClient/)
  })
})
