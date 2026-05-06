import { executeCommand } from '../executor.js'
import { getCLITarget } from '../../cli/index.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('executeCommand', () => {
  const testDir = join(tmpdir(), 'skill-networks-executor-test')
  const originalCwd = process.cwd()

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
`)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('executes echo command and returns result', async () => {
    const target = getCLITarget('mock')
    const command = ['echo', '{"session_id":"test-123","success":true}']

    const result = await executeCommand(command, target)

    expect(result.exitCode).toBe(0)
    expect(result.output.sessionId).toBe('test-123')
    expect(result.output.success).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('handles command failure', async () => {
    const target = getCLITarget('mock')
    const command = ['false'] // Always exits with code 1

    const result = await executeCommand(command, target)

    expect(result.exitCode).toBe(1)
  })

  it('handles non-existent command', async () => {
    const target = getCLITarget('mock')
    const command = ['nonexistent-command-xyz-123']

    const result = await executeCommand(command, target)

    expect(result.exitCode).toBe(1)
    expect(result.output.success).toBe(false)
    expect(result.output.error).toBeDefined()
  })

  it('measures duration', async () => {
    const target = getCLITarget('mock')
    const command = ['sleep', '0.1']

    const result = await executeCommand(command, target)

    expect(result.durationMs).toBeGreaterThanOrEqual(90)
  })

  it('routes OAuth token from ANTHROPIC_API_KEY to CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const oauthToken = 'sk-ant-oat01-test-token-value'
    process.env.ANTHROPIC_API_KEY = oauthToken
    try {
      const target = getCLITarget('mock')
      const result = await executeCommand(['env'], target)

      expect(result.output.rawOutput).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test-token-value')
      expect(result.output.rawOutput).not.toContain('ANTHROPIC_API_KEY=sk-ant-oat01')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('keeps regular API key in ANTHROPIC_API_KEY unchanged', async () => {
    const apiKey = 'sk-ant-api03-test-key-value'
    process.env.ANTHROPIC_API_KEY = apiKey
    try {
      const target = getCLITarget('mock')
      const result = await executeCommand(['env'], target)

      expect(result.output.rawOutput).toContain('ANTHROPIC_API_KEY=sk-ant-api03-test-key-value')
      expect(result.output.rawOutput).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-api03')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('strips CLAUDECODE env var from child process', async () => {
    process.env.CLAUDECODE = '1'
    try {
      const target = getCLITarget('mock')
      const command = ['env']

      const result = await executeCommand(command, target)

      expect(result.exitCode).toBe(0)
      expect(result.output.rawOutput).toBeDefined()
      expect(result.output.rawOutput).not.toContain('CLAUDECODE=')
      expect(result.output.rawOutput).toContain('PATH=')
    } finally {
      delete process.env.CLAUDECODE
    }
  })

  it('annotates error when both primary and fallback models are rate-limited', async () => {
    const target = getCLITarget('mock')
    const primaryModel = 'primary-model'
    const fallbackModel = 'fallback-model'
    // Command that outputs "overloaded" — triggers rate-limit detection for both calls
    const command = ['echo', '{"session_id":"rl-test","success":false,"error":"overloaded"}', '--model', primaryModel]

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await executeCommand(command, target, fallbackModel)

      // Should log primary fallback message and both-models-rate-limited message
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('rate-limited, falling back to')
      )
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`\\[executor\\] Both ${primaryModel} and ${fallbackModel} are rate-limited`))
      )

      // Should annotate the error
      expect(result.output.error).toContain('[both models rate-limited]')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('spawns CLI with correct working directory', async () => {
    // Create a subdirectory to use as workingDir
    const subDir = join(testDir, 'subdir')
    mkdirSync(subDir, { recursive: true })

    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: subdir
`)

    const target = getCLITarget('mock')
    const command = ['pwd']

    const result = await executeCommand(command, target)

    expect(result.exitCode).toBe(0)
    // The output should contain the subdirectory path
    expect(result.output.rawOutput).toContain('subdir')
  })

  describe('SDK path rate-limit retry (T5)', () => {
    it('retries with fallbackModel when executeQuery returns rate-limited result', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const successResult = {
        command: ['claude-agent-sdk', '--prompt', 'test'],
        output: {
          sessionId: 'sid-success',
          success: true,
          result: 'done',
        },
        durationMs: 100,
        exitCode: 0,
      }

      const rateLimitedResult = {
        command: ['claude-agent-sdk', '--prompt', 'test'],
        output: {
          sessionId: 'sid-fail',
          success: false,
          error: 'overloaded_error',
        },
        durationMs: 50,
        exitCode: 1,
      }

      // Mock target with executeQuery that returns rate-limited first, success second
      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce(rateLimitedResult)
        .mockResolvedValueOnce(successResult)

      const target = getCLITarget('mock')
      // Override with SDK executeQuery
      target.executeQuery = mockExecuteQuery
      // Provide isRateLimited from the real SDK adapter pattern
      target.isRateLimited = (output) => {
        const error = (output.error ?? '').toLowerCase()
        return ['overloaded', 'rate_limit'].some(p => error.includes(p))
      }

      try {
        const result = await executeCommand(
          ['claude-agent-sdk', '--prompt', 'test'],
          target,
          'claude-opus-4-7',  // fallbackModel
          'test prompt',       // prompt — triggers SDK path
        )

        // executeQuery called twice (first rate-limited, second success)
        expect(mockExecuteQuery).toHaveBeenCalledTimes(2)

        // Result should be the success result (second call)
        expect(result.output.sessionId).toBe('sid-success')
        expect(result.output.success).toBe(true)

        // Should have logged the rate-limit fallback message
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('rate-limited (SDK path)')
        )
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })

    it('returns SDK result directly when not rate-limited', async () => {
      const successResult = {
        command: ['claude-agent-sdk', '--prompt', 'test'],
        output: {
          sessionId: 'sid-ok',
          success: true,
          result: 'all good',
        },
        durationMs: 200,
        exitCode: 0,
      }

      const mockExecuteQuery = vi.fn().mockResolvedValueOnce(successResult)
      const target = getCLITarget('mock')
      target.executeQuery = mockExecuteQuery

      const result = await executeCommand(
        ['claude-agent-sdk', '--prompt', 'test'],
        target,
        'claude-opus-4-7',
        'test prompt',
      )

      // Should only call once (no retry needed)
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
      expect(result.output.sessionId).toBe('sid-ok')
      expect(result.output.success).toBe(true)
    })
  })

  // Rate-limit pattern detection tests.
  // isRateLimited is not exported; we verify it via the fallback path:
  // when a rate-limit pattern is detected AND a fallbackModel is provided,
  // executeCommand logs to console.error before retrying.
  describe('rate-limit pattern detection via fallback trigger', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleErrorSpy.mockRestore()
    })

    async function isDetectedAsRateLimited(errorText: string): Promise<boolean> {
      const target = getCLITarget('mock')
      // Echo JSON with the pattern in the error field so parseOutput puts it in
      // output.error, which isRateLimited checks.
      const payload = JSON.stringify({ session_id: 'rl-test', success: false, error: errorText })
      const command = ['echo', payload]
      await executeCommand(command, target, 'fallback-model')
      return consoleErrorSpy.mock.calls.length > 0
    }

    it('detects insufficient_quota as rate-limited', async () => {
      expect(await isDetectedAsRateLimited('insufficient_quota')).toBe(true)
    })

    it('detects exceeded your current quota as rate-limited', async () => {
      expect(await isDetectedAsRateLimited('exceeded your current quota')).toBe(true)
    })

    it('detects quota_exceeded as rate-limited', async () => {
      expect(await isDetectedAsRateLimited('quota_exceeded')).toBe(true)
    })

    it('detects billing_hard_limit as rate-limited', async () => {
      expect(await isDetectedAsRateLimited('billing_hard_limit')).toBe(true)
    })

    it('does not treat clean success output as rate-limited', async () => {
      const target = getCLITarget('mock')
      const payload = JSON.stringify({ session_id: 'ok-test', success: true })
      const command = ['echo', payload]
      await executeCommand(command, target, 'fallback-model')
      expect(consoleErrorSpy.mock.calls.length).toBe(0)
    })
  })
})
