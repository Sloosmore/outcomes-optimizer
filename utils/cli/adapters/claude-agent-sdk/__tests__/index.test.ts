import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getCLITarget, runPreflight } from '../../../index.js'
import { cliAdapterSchema } from '../../../../config/schema.js'
import { emitSdkMessage } from '../index.js'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockImplementation(async () => {
    throw new Error('No API key configured')
  }),
}))

const testDir = join(tmpdir(), 'sdk-adapter-test-' + process.pid)
let originalCwd: string

beforeEach(() => {
  originalCwd = process.cwd()
  mkdirSync(testDir, { recursive: true })
  process.chdir(testDir)
  writeFileSync(
    join(testDir, 'config.yaml'),
    `campaign:\n  name: test\ndatabase:\n  adapter: none\ncli:\n  adapter: claude-agent-sdk\n  workingDir: .\n`,
  )
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(testDir, { recursive: true, force: true })
})

describe('claude-agent-sdk adapter registration and config', () => {
  it('cliAdapterSchema accepts claude-agent-sdk', () => {
    expect(() => cliAdapterSchema.parse('claude-agent-sdk')).not.toThrow()
  })

  it('getCLITarget returns target with name claude-agent-sdk', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.name).toBe('claude-agent-sdk')
  })

  it('target.skillsDir ends with .claude/skills', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.skillsDir.endsWith('.claude/skills')).toBe(true)
  })

  it('target.fallbackModel is claude-opus-4-7', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.fallbackModel).toBe('claude-opus-4-7')
  })

  it('runPreflight creates .claude/settings.json with correct permissions', async () => {
    const target = getCLITarget('claude-agent-sdk')
    await runPreflight(target)

    const settingsPath = join(testDir, '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(content.permissions.allow).toEqual(['*'])
    expect(Array.isArray(content.permissions.deny)).toBe(true)
    expect(content.permissions.deny).toContain('Bash(rm -rf *)')
  })
})

describe('claude-agent-sdk adapter isRateLimited', () => {
  it('returns true for "Service overloaded. resets in 60s"', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.isRateLimited!({ success: false, sessionId: 'x', error: 'Service overloaded. resets in 60s' })).toBe(true)
  })

  it('returns false for successful output', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.isRateLimited!({ success: true, sessionId: 'x' })).toBe(false)
  })

  it('returns true for "overloaded" error', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.isRateLimited!({ success: false, sessionId: 'x', error: 'overloaded' })).toBe(true)
  })

  it('returns true for "rate_limit exceeded" error', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.isRateLimited!({ success: false, sessionId: 'x', error: 'rate_limit exceeded' })).toBe(true)
  })

  it('returns true for quota exhaustion in error', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.isRateLimited!({ success: false, sessionId: 'x', error: 'insufficient_quota' })).toBe(true)
  })

  it('detects rate limit in stderr stream', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.isRateLimited!(
      { success: true, sessionId: 'x' },
      { stdout: '', stderr: 'Error: rate_limit exceeded' },
    )).toBe(true)
  })

  it('detects rate limit in stdout stream', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(target.isRateLimited!(
      { success: true, sessionId: 'x' },
      { stdout: 'overloaded, please retry', stderr: '' },
    )).toBe(true)
  })
})

describe('claude-agent-sdk adapter parseOutput', () => {
  it('parseOutput is undefined', () => {
    const target = getCLITarget('claude-agent-sdk')
    expect(typeof target.parseOutput).toBe('undefined')
  })
})

describe('claude-agent-sdk adapter executeQuery error handling', () => {
  it('returns error result when credentials are missing — does not throw', async () => {
    const target = getCLITarget('claude-agent-sdk')

    const savedKey = process.env.ANTHROPIC_API_KEY
    const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN

    try {
      const result = await target.executeQuery!('test', {})

      expect(result.output.success).toBe(false)
      expect(typeof result.output.error).toBe('string')
      expect(result.output.error!.length).toBeGreaterThan(0)
      expect(result.exitCode).toBe(1)
    } finally {
      if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey
      if (savedOauth) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth
    }
  })
})

describe('emitSdkMessage source routing (T1)', () => {
  it('assistant msg with tool_use block emits { source: block.name }', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'ls' } }]
    }, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Bash',
      payload: { tool_use_id: 'tu-1', input: { command: 'ls' } }
    }))
  })

  it('assistant msg with nested message.content (SDK 0.2.79 SDKAssistantMessage) emits tool_use', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    // SDK 0.2.79: SDKAssistantMessage has message.content (not top-level content)
    emitSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', id: 'tu-sdk', input: { file_path: '/foo' } }] }
    } as any, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Read',
      payload: { tool_use_id: 'tu-sdk', input: { file_path: '/foo' } }
    }))
  })

  it('assistant msg with non-empty text emits { source: "assistant" }', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }]
    }, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'assistant',
      payload: { text: 'Hello world' }
    }))
  })

  it('assistant msg with empty text emits zero times', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      content: [{ type: 'text', text: '' }]
    }, emitter, ctx)
    expect(emitter.emit).not.toHaveBeenCalled()
  })

  it('assistant msg with whitespace-only text emits zero times', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      content: [{ type: 'text', text: '   \n  ' }]
    }, emitter, ctx)
    expect(emitter.emit).not.toHaveBeenCalled()
  })

  it('result msg with is_error:false emits { source: "result:success" }', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'result',
      is_error: false,
      duration_ms: 100,
      total_cost_usd: 0.01,
      num_turns: 5
    }, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'result:success'
    }))
  })

  it('result msg with is_error:true emits { source: "result:error" }', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'result',
      is_error: true
    }, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'result:error'
    }))
  })

  it('user msg emits zero times', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({ type: 'user' }, emitter, ctx)
    expect(emitter.emit).not.toHaveBeenCalled()
  })

  it('system msg emits zero times', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({ type: 'system' }, emitter, ctx)
    expect(emitter.emit).not.toHaveBeenCalled()
  })

  it('assistant msg with tool_result block emits { source: "tool_result" }', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: false }]
    } as any, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'tool_result',
      payload: { tool_use_id: 'tu-1', is_error: false }
    }))
  })
})

describe('emitSdkMessage token usage emission (T1b)', () => {
  it('assistant msg with usage in message.usage emits token_usage event with all cache fields', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      message: {
        content: [],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
      },
    } as any, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'token_usage',
      payload: expect.objectContaining({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
        total_tokens: 150,
      }),
    }))
  })

  it('assistant msg with top-level usage emits token_usage event', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      usage: { input_tokens: 5, output_tokens: 3 },
    } as any, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'token_usage',
      payload: expect.objectContaining({
        input_tokens: 5,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        total_tokens: 8,
      }),
    }))
  })

  it('assistant msg without usage does not emit token_usage event', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    }, emitter, ctx)
    const calls = emitter.emit.mock.calls
    for (const [row] of calls) {
      expect((row as { source: string }).source).not.toBe('token_usage')
    }
  })
})

describe('emitSdkMessage identity fields (T2)', () => {
  it('all emitted rows have process_id, process_name, resource_id from ctx', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: 'R' }
    emitSdkMessage({
      type: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', id: 'tu-2', input: { path: '/tmp' } }]
    }, emitter, ctx)
    emitSdkMessage({
      type: 'result',
      is_error: false
    }, emitter, ctx)

    expect(emitter.emit).toHaveBeenCalledTimes(2)
    for (const call of emitter.emit.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        process_id: 'P',
        process_name: 'test',
        resource_id: 'R',
      }))
    }
  })

  it('emits resource_id: null when resourceId is null (unlinked process)', () => {
    const emitter = { emit: vi.fn() }
    const ctx = { processId: 'P', processName: 'test', resourceId: null }
    emitSdkMessage({
      type: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', id: 'tu-null', input: {} }]
    }, emitter, ctx)
    expect(emitter.emit).toHaveBeenCalledOnce()
    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: null }))
  })
})

describe('executeQuery with missing env vars (T3)', () => {
  it('EVAL_PROCESS_ID absent → no emit, valid result', async () => {
    const saved = {
      EVAL_PROCESS_ID: process.env.EVAL_PROCESS_ID,
      EVAL_CAMPAIGN_ID: process.env.EVAL_CAMPAIGN_ID,
      EVAL_SKILL_RESOURCE_ID: process.env.EVAL_SKILL_RESOURCE_ID,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    }
    delete process.env.EVAL_PROCESS_ID
    delete process.env.EVAL_CAMPAIGN_ID
    delete process.env.EVAL_SKILL_RESOURCE_ID
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_KEY

    // Re-mock the SDK to return a successful conversation
    const sdkModule = await import('@anthropic-ai/claude-agent-sdk')
    const mockQuery = vi.mocked(sdkModule.query)
    mockQuery.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'result', session_id: 'test-session', is_error: false, result: 'done' }
      }
    } as any)

    try {
      const target = getCLITarget('claude-agent-sdk')
      const result = await target.executeQuery!('test prompt', {})

      expect(result.output.success).toBe(true)
      expect(result.output.sessionId).toBe('test-session')
      expect(result.exitCode).toBe(0)
    } finally {
      // Restore env
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) process.env[key] = val
        else delete process.env[key]
      }
    }
  })
})

describe('executeQuery output unaffected by emission (T4)', () => {
  it('returns correct result despite 3 assistant messages + 1 result emitted', async () => {
    const saved = {
      EVAL_PROCESS_ID: process.env.EVAL_PROCESS_ID,
      EVAL_CAMPAIGN_ID: process.env.EVAL_CAMPAIGN_ID,
      EVAL_SKILL_RESOURCE_ID: process.env.EVAL_SKILL_RESOURCE_ID,
      EVAL_PROCESS: process.env.EVAL_PROCESS,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    }

    process.env.EVAL_PROCESS_ID = 'test-pid'
    process.env.EVAL_SKILL_RESOURCE_ID = 'test-rid'
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'test-key'

    // Re-mock the SDK to return a conversation with multiple messages
    const sdkModule = await import('@anthropic-ai/claude-agent-sdk')
    const mockQuery = vi.mocked(sdkModule.query)
    mockQuery.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 'tu-1', input: {} }] }
        yield { type: 'assistant', content: [{ type: 'text', text: 'Working on it' }] }
        yield { type: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: 'tu-2', input: {} }] }
        yield { type: 'result', session_id: 'sid-123', is_error: false, result: 'All done', total_cost_usd: 0.05, duration_ms: 3000 }
      }
    } as any)

    try {
      const target = getCLITarget('claude-agent-sdk')
      const result = await target.executeQuery!('test prompt', {})

      expect(result.output.success).toBe(true)
      expect(result.output.sessionId).toBe('sid-123')
      expect(result.exitCode).toBe(0)
    } finally {
      // Restore env
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) process.env[key] = val
        else delete process.env[key]
      }
    }
  })
})
