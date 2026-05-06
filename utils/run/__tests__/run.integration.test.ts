import { run } from '../index.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MAX_PROMPT_LENGTH } from '../../types.js'

describe('run() with prompt validation', () => {
  const testDir = join(tmpdir(), 'skill-networks-run-test')
  const originalCwd = process.cwd()

  beforeEach(() => {
    // Clean up and recreate test directory
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)

    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: .
`)

    mkdirSync(join(testDir, 'skills', 'test-skill'), { recursive: true })
    writeFileSync(
      join(testDir, 'skills', 'test-skill', 'SKILL.md'),
      '# Test Skill\nA test skill'
    )
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('successfully runs full integration flow', async () => {
    const result = await run({ prompt: 'test prompt' })

    expect(result.sync).toBeDefined()
    expect(result.sync.length).toBeGreaterThan(0)
    expect(result.sync[0].success).toBe(true)
    expect(result.execution).toBeDefined()
    expect(result.execution.command).toContain('echo')
    expect(result.execution.output.success).toBe(true)
    expect(result.execution.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('allows running with no skills', async () => {
    rmSync(join(testDir, 'skills'), { recursive: true, force: true })
    // Create an empty user skills dir so runner's ~/.config/duoidal/skills/ is not picked up
    const emptyUserSkillsDir = join(testDir, '90d045f1-da05-4b5b-859e-459547849164')
    mkdirSync(emptyUserSkillsDir, { recursive: true })

    const result = await run({ prompt: 'test', userSkillsRoot: emptyUserSkillsDir })

    expect(result.sync).toBeDefined()
    expect(result.sync.length).toBe(0)
    expect(result.execution.output.success).toBe(true)
  })

  it('throws error for empty prompt', async () => {
    await expect(run({ prompt: '' }))
      .rejects.toThrow('Prompt cannot be empty')
  })

  it('throws error for whitespace-only prompt', async () => {
    await expect(run({ prompt: '   ' }))
      .rejects.toThrow('Prompt cannot be empty')
  })

  it('throws error when prompt exceeds max length', async () => {
    const longPrompt = 'a'.repeat(MAX_PROMPT_LENGTH + 1)

    await expect(run({ prompt: longPrompt }))
      .rejects.toThrow(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH.toLocaleString()} characters`)
  })

  it('trims whitespace from prompt', async () => {
    const result = await run({ prompt: '  test prompt  ' })

    expect(result.execution).toBeDefined()
    expect(result.execution.output.success).toBe(true)
  })
})
