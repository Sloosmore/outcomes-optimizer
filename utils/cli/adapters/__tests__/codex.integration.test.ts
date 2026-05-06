import { run } from '../../../run/index.js'
import { getCLITarget } from '../../index.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const hasOpenAICredentials = () => !!process.env.OPENAI_API_KEY

describe('codex adapter: Environment validation', () => {
  const testDir = join(tmpdir(), 'skill-networks-codex-validation-test')
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
  adapter: codex
  workingDir: .
`)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('throws error when OPENAI_API_KEY missing', () => {
    const savedKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY

    expect(() => {
      const target = getCLITarget('codex')
      target.validateEnvironment()
    }).toThrow(/OPENAI_API_KEY/)

    if (savedKey) process.env.OPENAI_API_KEY = savedKey
  })

  it('accepts OPENAI_API_KEY', () => {
    const savedKey = process.env.OPENAI_API_KEY

    process.env.OPENAI_API_KEY = 'test-key'

    expect(() => {
      const target = getCLITarget('codex')
      target.validateEnvironment()
    }).not.toThrow()

    // Restore original value
    if (savedKey) {
      process.env.OPENAI_API_KEY = savedKey
    } else {
      delete process.env.OPENAI_API_KEY
    }
  })

  it('provides helpful error message', () => {
    const savedKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY

    try {
      const target = getCLITarget('codex')
      target.validateEnvironment()
      expect.fail('Should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('OPENAI_API_KEY')
    }

    if (savedKey) process.env.OPENAI_API_KEY = savedKey
  })
})

describe('codex adapter: Full execution flow', () => {
  const testDir = join(tmpdir(), 'skill-networks-codex-integration')
  const originalCwd = process.cwd()
  let syncedSkillPath: string | null = null

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)

    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: integration-test
database:
  adapter: none
cli:
  adapter: codex
  workingDir: .
`)

    mkdirSync(join(testDir, 'skills', 'test-skill'), { recursive: true })
    writeFileSync(
      join(testDir, 'skills', 'test-skill', 'SKILL.md'),
      '# Test Skill\nA test skill for integration testing'
    )

    // Track the synced skill path for cleanup
    const target = getCLITarget('codex')
    syncedSkillPath = join(target.skillsDir, 'test-skill')

    // Clean up any existing test-skill from previous runs
    if (require('fs').existsSync(syncedSkillPath)) {
      rmSync(syncedSkillPath, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    // Clean up synced skill from real codex directory
    if (syncedSkillPath && require('fs').existsSync(syncedSkillPath)) {
      rmSync(syncedSkillPath, { recursive: true, force: true })
    }

    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it.runIf(hasOpenAICredentials())(
    'executes real prompt with codex',
    { timeout: 30000 },
    async () => {
      const result = await run({ prompt: 'say hello' })

      expect(result.sync).toBeDefined()
      expect(result.sync.length).toBeGreaterThan(0)
      expect(result.execution).toBeDefined()
      expect(result.execution.output).toBeDefined()
    }
  )
})
