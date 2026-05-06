import { getCLITarget } from '../index.js'
import { syncSkills } from '../../sync/index.js'
import { executeCommand } from '../../run/executor.js'
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { realpathSync } from 'fs'

describe('workingDir integration: Skill discovery', () => {
  const testDir = join(tmpdir(), 'skill-networks-workingdir-test')
  const originalCwd = process.cwd()

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('syncs skills to workingDir when set to current directory', async () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: .
`)

    // Create a test skill
    mkdirSync(join(testDir, 'skills', 'test-skill'), { recursive: true })
    writeFileSync(
      join(testDir, 'skills', 'test-skill', 'SKILL.md'),
      '# Test Skill\nA test skill'
    )

    const target = getCLITarget('mock')

    // Verify target configuration
    expect(target.workingDir).toBe(realpathSync(testDir))
    expect(target.skillsDir).toBe(join(realpathSync(testDir), '.mock', 'skills'))

    // Sync skills
    const syncResults = await syncSkills()
    expect(syncResults[0].success).toBe(true)

    // Verify skills were synced to the correct location
    expect(existsSync(join(testDir, '.mock', 'skills', 'test-skill'))).toBe(true)
    expect(existsSync(join(testDir, '.mock', 'skills', 'test-skill', 'SKILL.md'))).toBe(true)
  })

  it('syncs skills to subdirectory when workingDir is set to subdirectory', async () => {
    const subDir = join(testDir, 'packages', 'frontend')
    mkdirSync(subDir, { recursive: true })

    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: packages/frontend
`)

    // Create a test skill
    mkdirSync(join(testDir, 'skills', 'test-skill'), { recursive: true })
    writeFileSync(
      join(testDir, 'skills', 'test-skill', 'SKILL.md'),
      '# Test Skill\nA test skill'
    )

    const target = getCLITarget('mock')

    // Verify target configuration
    expect(target.workingDir).toBe(join(realpathSync(testDir), 'packages', 'frontend'))
    expect(target.skillsDir).toBe(join(realpathSync(testDir), 'packages', 'frontend', '.mock', 'skills'))

    // Sync skills
    const syncResults = await syncSkills()
    expect(syncResults[0].success).toBe(true)

    // Verify skills were synced to the subdirectory
    expect(existsSync(join(subDir, '.mock', 'skills', 'test-skill'))).toBe(true)
    expect(existsSync(join(subDir, '.mock', 'skills', 'test-skill', 'SKILL.md'))).toBe(true)
  })

  it('uses process.cwd() as workingDir when workingDir is omitted', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
`)

    const target = getCLITarget('mock')

    // When workingDir is omitted, baseDir is homedir, so workingDir should be process.cwd()
    expect(target.workingDir).toBe(realpathSync(process.cwd()))
    expect(target.skillsDir).toBe(join(homedir(), '.mock', 'skills'))
  })

  it('executes CLI from workingDir', async () => {
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

    // Execute pwd command to verify working directory
    const result = await executeCommand(['pwd'], target)

    expect(result.exitCode).toBe(0)
    // The output should contain the subdirectory path
    expect(result.output.rawOutput).toContain('subdir')
  })

  it('sets up correct paths for claude-code adapter with workingDir', () => {
    const subDir = join(testDir, 'packages', 'app')
    mkdirSync(subDir, { recursive: true })

    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: packages/app
`)

    const target = getCLITarget('claude-code')

    // Verify claude-code target configuration
    expect(target.workingDir).toBe(join(realpathSync(testDir), 'packages', 'app'))
    expect(target.skillsDir).toBe(join(realpathSync(testDir), 'packages', 'app', '.claude', 'skills'))

    // This means:
    // 1. Skills will be synced to: <testDir>/packages/app/.claude/skills/
    // 2. CLI will run from: <testDir>/packages/app/
    // 3. Claude Code will look for skills at: .claude/skills/ (relative to CWD)
    // 4. Therefore, Claude Code will find the skills! ✅
  })

  it('uses global skills when workingDir is omitted for claude-code', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
`)

    const target = getCLITarget('claude-code')

    // When workingDir is omitted:
    // 1. Skills sync to: ~/.claude/skills/ (global)
    // 2. CLI runs from: current workspace directory
    // 3. Claude Code discovers global skills from homedir
    expect(target.skillsDir).toBe(join(homedir(), '.claude', 'skills'))
    expect(target.workingDir).toBe(realpathSync(process.cwd()))
  })
})

describe('workingDir integration: Real skill discovery paths', () => {
  const testDir = join(tmpdir(), 'skill-networks-real-paths-test')
  const originalCwd = process.cwd()

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('creates discoverable skill structure for workspace root', async () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: .
`)

    // Create a test skill
    mkdirSync(join(testDir, 'skills', 'example-skill'), { recursive: true })
    writeFileSync(
      join(testDir, 'skills', 'example-skill', 'SKILL.md'),
      '# Example Skill\nAn example skill'
    )

    const target = getCLITarget('claude-code')
    const syncResults = await syncSkills()

    expect(syncResults[0].success).toBe(true)

    // Verify the skill structure is correct for Claude Code discovery
    const expectedSkillPath = join(testDir, '.claude', 'skills', 'example-skill')
    expect(existsSync(expectedSkillPath)).toBe(true)
    expect(existsSync(join(expectedSkillPath, 'SKILL.md'))).toBe(true)

    // Verify paths align for discovery
    // CLI runs from: testDir
    // Skills are at: testDir/.claude/skills/
    // Claude Code looks for: .claude/skills/ (relative to CWD)
    // Result: Skills will be discovered! ✅
    expect(target.workingDir).toBe(realpathSync(testDir))
    expect(target.skillsDir).toBe(join(realpathSync(testDir), '.claude', 'skills'))
  })

  it('creates discoverable skill structure for monorepo subdirectory', async () => {
    const packageDir = join(testDir, 'packages', 'backend')
    mkdirSync(packageDir, { recursive: true })

    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: packages/backend
`)

    // Create a test skill
    mkdirSync(join(testDir, 'skills', 'backend-skill'), { recursive: true })
    writeFileSync(
      join(testDir, 'skills', 'backend-skill', 'SKILL.md'),
      '# Backend Skill\nA backend-specific skill'
    )

    const target = getCLITarget('claude-code')
    const syncResults = await syncSkills()

    expect(syncResults[0].success).toBe(true)

    // Verify the skill structure is correct for Claude Code discovery
    const expectedSkillPath = join(packageDir, '.claude', 'skills', 'backend-skill')
    expect(existsSync(expectedSkillPath)).toBe(true)
    expect(existsSync(join(expectedSkillPath, 'SKILL.md'))).toBe(true)

    // Verify paths align for discovery
    // CLI runs from: testDir/packages/backend
    // Skills are at: testDir/packages/backend/.claude/skills/
    // Claude Code looks for: .claude/skills/ (relative to CWD)
    // Result: Skills will be discovered! ✅
    expect(target.workingDir).toBe(join(realpathSync(testDir), 'packages', 'backend'))
    expect(target.skillsDir).toBe(join(realpathSync(testDir), 'packages', 'backend', '.claude', 'skills'))
  })
})
