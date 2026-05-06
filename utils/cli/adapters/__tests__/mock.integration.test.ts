import { run } from '../../../run/index.js'
import { getCLITarget } from '../../index.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('mock adapter: Environment validation', () => {
  const testDir = join(tmpdir(), 'skill-networks-mock-validation-test')
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
  workingDir: .
`)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('does not require any environment variables', () => {
    expect(() => {
      const target = getCLITarget('mock')
      target.validateEnvironment()
    }).not.toThrow()
  })
})

describe('mock adapter: Full execution flow', () => {
  const testDir = join(tmpdir(), 'skill-networks-mock-integration')
  const originalCwd = process.cwd()

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)

    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: integration-test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: .
`)

    mkdirSync(join(testDir, 'skills', 'test-skill'), { recursive: true })
    writeFileSync(
      join(testDir, 'skills', 'test-skill', 'SKILL.md'),
      '# Test Skill\nA test skill for integration testing'
    )
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('executes prompt with mock adapter', async () => {
    const result = await run({ prompt: 'test prompt' })

    expect(result.sync).toBeDefined()
    expect(result.sync.length).toBeGreaterThan(0)
    expect(result.execution.output.success).toBe(true)
    expect(result.execution.command[0]).toBe('echo')
  })

  it('always succeeds', async () => {
    const result = await run({ prompt: 'any prompt works' })

    expect(result.execution.output.success).toBe(true)
    expect(result.execution.exitCode).toBe(0)
  })
})
