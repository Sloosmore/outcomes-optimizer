import 'dotenv/config'
import { run } from '../../../run/index.js'
import { getCLITarget } from '../../index.js'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Integration tests that spawn the real `claude` CLI are opt-in via
// RUN_INTEGRATION=true. Gating on API-key presence alone (the previous
// behavior) caused this test to run on any runner with ANTHROPIC_API_KEY
// in the environment — regardless of whether the caller wanted to burn
// credits or whether the CLI was in a runnable state. On self-hosted
// runners this produced a deterministic "expected 0, got 1" failure
// because `claude -p "say hello"` exits non-zero in that context. Match
// the convention documented in packages/CLAUDE.md: RUN_INTEGRATION is the
// sole gate for tests that hit real external systems.
const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION
const canRunClaudeCode = () =>
  RUN_INTEGRATION &&
  (!!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN) &&
  process.getuid?.() !== 0 // claude --dangerously-skip-permissions rejects root

describe('claude-code adapter: Environment validation', () => {
  const testDir = join(tmpdir(), 'skill-networks-claude-validation-test')
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
  adapter: claude-code
  workingDir: .
`)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('throws error when both env vars missing in CI', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const savedCI = process.env.GITHUB_ACTIONS
    const savedCIGeneric = process.env.CI

    try {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.CI
      process.env.GITHUB_ACTIONS = 'true'

      expect(() => {
        const target = getCLITarget('claude-code')
        target.validateEnvironment()
      }).toThrow(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/)
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
      else delete process.env.ANTHROPIC_API_KEY
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      if (savedCI !== undefined) process.env.GITHUB_ACTIONS = savedCI
      else delete process.env.GITHUB_ACTIONS
      if (savedCIGeneric !== undefined) process.env.CI = savedCIGeneric
      else delete process.env.CI
    }
  })

  it('throws error when both env vars missing with CI=true', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const savedCI = process.env.GITHUB_ACTIONS
    const savedCIGeneric = process.env.CI

    try {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.GITHUB_ACTIONS
      process.env.CI = 'true'

      expect(() => {
        const target = getCLITarget('claude-code')
        target.validateEnvironment()
      }).toThrow(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/)
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
      else delete process.env.ANTHROPIC_API_KEY
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      if (savedCI !== undefined) process.env.GITHUB_ACTIONS = savedCI
      else delete process.env.GITHUB_ACTIONS
      if (savedCIGeneric !== undefined) process.env.CI = savedCIGeneric
      else delete process.env.CI
    }
  })

  it('does not throw when both env vars missing locally', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const savedCI = process.env.GITHUB_ACTIONS
    const savedCIGeneric = process.env.CI

    try {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.GITHUB_ACTIONS
      delete process.env.CI

      expect(() => {
        const target = getCLITarget('claude-code')
        target.validateEnvironment()
      }).not.toThrow()
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
      else delete process.env.ANTHROPIC_API_KEY
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      if (savedCI !== undefined) process.env.GITHUB_ACTIONS = savedCI
      else delete process.env.GITHUB_ACTIONS
      if (savedCIGeneric !== undefined) process.env.CI = savedCIGeneric
      else delete process.env.CI
    }
  })

  it('accepts ANTHROPIC_API_KEY', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN

    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      process.env.ANTHROPIC_API_KEY = 'test-key'

      expect(() => {
        const target = getCLITarget('claude-code')
        target.validateEnvironment()
      }).not.toThrow()
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
      else delete process.env.ANTHROPIC_API_KEY
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
  })

  it('accepts CLAUDE_CODE_OAUTH_TOKEN', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN

    try {
      delete process.env.ANTHROPIC_API_KEY
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token'

      expect(() => {
        const target = getCLITarget('claude-code')
        target.validateEnvironment()
      }).not.toThrow()
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
      else delete process.env.ANTHROPIC_API_KEY
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
  })

  it('provides helpful error message in CI', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const savedCI = process.env.GITHUB_ACTIONS
    const savedCIGeneric = process.env.CI

    try {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.CI
      process.env.GITHUB_ACTIONS = 'true'

      const target = getCLITarget('claude-code')
      target.validateEnvironment()
      expect.fail('Should have thrown')
    } catch (err) {
      if ((err as Error).message === 'Should have thrown') throw err
      expect((err as Error).message).toContain('claude /login')
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
      else delete process.env.ANTHROPIC_API_KEY
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      if (savedCI !== undefined) process.env.GITHUB_ACTIONS = savedCI
      else delete process.env.GITHUB_ACTIONS
      if (savedCIGeneric !== undefined) process.env.CI = savedCIGeneric
      else delete process.env.CI
    }
  })
})

describe('claude-code adapter: Full execution flow', () => {
  let testDir: string
  const originalCwd = process.cwd()
  let syncedSkillPath: string | null = null

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'skill-networks-claude-integration-'))
    process.chdir(testDir)

    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: integration-test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: .
`)

    mkdirSync(join(testDir, 'skills', 'test-skill'), { recursive: true })
    writeFileSync(
      join(testDir, 'skills', 'test-skill', 'SKILL.md'),
      '# Test Skill\nA test skill for integration testing'
    )

    // Track the synced skill path for cleanup
    const target = getCLITarget('claude-code')
    syncedSkillPath = join(target.skillsDir, 'test-skill')

    // Clean up any existing test-skill from previous runs
    if (require('fs').existsSync(syncedSkillPath)) {
      rmSync(syncedSkillPath, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    // Clean up synced skill from real claude-code directory
    if (syncedSkillPath && require('fs').existsSync(syncedSkillPath)) {
      rmSync(syncedSkillPath, { recursive: true, force: true })
    }

    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it.runIf(canRunClaudeCode())(
    'executes real prompt with claude-code',
    { timeout: 30000 },
    async () => {
      const result = await run({ prompt: 'say hello' })

      expect(result.sync).toBeDefined()
      expect(result.sync.length).toBeGreaterThan(0)
      expect(result.execution).toBeDefined()
      expect(result.execution.output).toBeDefined()
      expect(result.execution.output.sessionId).toBeDefined()
      expect(result.execution.exitCode).toBe(0)
      expect(result.execution.output.success).toBe(true)
    }
  )
})
