/**
 * Unit tests for runSandboxAgent (sandbox-agent-runner.ts).
 *
 * Tests verify SSH command construction and JSON output parsing
 * without real SSH connectivity. SshManager is injected via opts.ssh.
 *
 * Contract: the script's final stdout JSON line is `{ text: string }`. The
 * runner is intentionally dumb — it does not parse ports, build URLs, or
 * detect artifacts. Any URL the agent should render lives inside `text`.
 */
import { vi, describe, it, expect } from 'vitest'
import type { SandboxAgentRunnerOptions } from '../adapters/research/sandbox-agent-runner.js'
import type { SshManager } from '../adapters/research/ssh-manager.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((path: unknown, _enc?: unknown) => {
      if (typeof path === 'string' && path.includes('research.mjs')) {
        return '#!/usr/bin/env node\nconsole.log("stub")'
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- delegating to actual
      return (actual.readFileSync as any)(path, _enc)
    }),
  }
})

import { runSandboxAgent } from '../adapters/research/sandbox-agent-runner.js'
import { RESEARCH } from '../constants.js'

function makeMockSsh(execResult: () => Promise<string>) {
  const close = vi.fn()
  const execOnOpenClaw = vi.fn().mockImplementation(execResult)
  const ssh = { execOnOpenClaw, close, isConfigured: vi.fn().mockReturnValue(true) } as unknown as SshManager
  return { ssh, close, execOnOpenClaw }
}

const BASE_OPTS: Omit<SandboxAgentRunnerOptions, 'ssh'> = {
  host: '1.2.3.4',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n',
  sandboxId: 'abc123-sandbox-id',
  timeoutMs: 5_000,
}

describe('runSandboxAgent', () => {
  it('returns text from a valid {text} JSON line', async () => {
    const expected = {
      text: 'Research complete. Rendered artifact: https://artifact-abc123-49001.example.com/',
    }
    const { ssh, close } = makeMockSsh(() =>
      Promise.resolve(`[log output]\n${JSON.stringify(expected)}\n`),
    )

    const result = await runSandboxAgent('Show me a diagram', { ...BASE_OPTS, ssh })

    expect(result.text).toBe(expected.text)
    expect(close).toHaveBeenCalledOnce()
  })

  it('returns text-only when no URL is inlined', async () => {
    const { ssh } = makeMockSsh(() =>
      Promise.resolve(JSON.stringify({ text: 'Just a summary' }) + '\n'),
    )

    const result = await runSandboxAgent('What is X?', { ...BASE_OPTS, ssh })

    expect(result.text).toBe('Just a summary')
  })

  it('falls back to raw stdout when no JSON line found', async () => {
    const { ssh } = makeMockSsh(() =>
      Promise.resolve('raw output with no JSON\n'),
    )

    const result = await runSandboxAgent('prompt', { ...BASE_OPTS, ssh })

    expect(result.text).toBe('raw output with no JSON')
  })

  it('picks the LAST JSON {text} object (ignores earlier log lines)', async () => {
    const stdout = [
      '{"debug":"intermediate","text":"not this"}',
      'some log',
      JSON.stringify({ text: 'Final answer' }),
    ].join('\n')
    const { ssh } = makeMockSsh(() => Promise.resolve(stdout))

    const result = await runSandboxAgent('prompt', { ...BASE_OPTS, ssh })

    expect(result.text).toBe('Final answer')
  })

  it('throws and closes SSH when execOnOpenClaw rejects', async () => {
    const { ssh, close } = makeMockSsh(() =>
      Promise.reject(new Error('SSH connection refused')),
    )

    await expect(runSandboxAgent('prompt', { ...BASE_OPTS, ssh })).rejects.toThrow(
      'runSandboxAgent SSH error: SSH connection refused',
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes SSH even when JSON parsing succeeds', async () => {
    const { ssh, close } = makeMockSsh(() =>
      Promise.resolve(JSON.stringify({ text: 'done' })),
    )

    await runSandboxAgent('prompt', { ...BASE_OPTS, ssh })

    expect(close).toHaveBeenCalledOnce()
  })

  it('SSH command forwards the configured ANTHROPIC_BASE_URL (in-sandbox CLIProxyAPI)', async () => {
    const { ssh, execOnOpenClaw } = makeMockSsh(() =>
      Promise.resolve(JSON.stringify({ text: 'ok' })),
    )

    await runSandboxAgent('test prompt', { ...BASE_OPTS, ssh })

    const command: string = execOnOpenClaw.mock.calls[0][0] as string
    expect(command).toContain('ANTHROPIC_BASE_URL=')
    expect(command).toContain(RESEARCH.SANDBOX_ANTHROPIC_BASE_URL)
    // Sanity: default points at the in-sandbox CLIProxyAPI on localhost:8317,
    // not the external proxy.example.com (which the sandbox cannot resolve).
    expect(command).toContain('http://localhost:8317')
  })

  it('SSH command forwards ANTHROPIC_API_KEY and SANDBOX_MODEL env vars', async () => {
    const { ssh, execOnOpenClaw } = makeMockSsh(() =>
      Promise.resolve(JSON.stringify({ text: 'ok' })),
    )

    await runSandboxAgent('test prompt', { ...BASE_OPTS, ssh })

    const command: string = execOnOpenClaw.mock.calls[0][0] as string
    expect(command).toContain('ANTHROPIC_API_KEY=')
    expect(command).toContain(RESEARCH.SANDBOX_ANTHROPIC_API_KEY)
    expect(command).toContain('SANDBOX_MODEL=')
    expect(command).toContain(RESEARCH.SANDBOX_MODEL)
  })

  it('SSH command cd`s into RESEARCH.SANDBOX_WORKDIR before running the script', async () => {
    const { ssh, execOnOpenClaw } = makeMockSsh(() =>
      Promise.resolve(JSON.stringify({ text: 'ok' })),
    )

    await runSandboxAgent('test prompt', { ...BASE_OPTS, ssh })

    const command: string = execOnOpenClaw.mock.calls[0][0] as string
    expect(command).toContain(`cd '${RESEARCH.SANDBOX_WORKDIR}'`)
  })

  it('returns { text: "No result" } when stdout is empty', async () => {
    const { ssh } = makeMockSsh(() => Promise.resolve(''))

    const result = await runSandboxAgent('prompt', { ...BASE_OPTS, ssh })

    expect(result.text).toBe('No result')
  })

  it('SSH command includes the sandboxId in the SANDBOX_ID env var', async () => {
    const { ssh, execOnOpenClaw } = makeMockSsh(() =>
      Promise.resolve(JSON.stringify({ text: 'ok' })),
    )

    await runSandboxAgent('prompt', { ...BASE_OPTS, ssh, sandboxId: 'my-sandbox-xyz' })

    const command: string = execOnOpenClaw.mock.calls[0][0] as string
    expect(command).toContain('SANDBOX_ID=')
    expect(command).toContain('my-sandbox-xyz')
  })
})
