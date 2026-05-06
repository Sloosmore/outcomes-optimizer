import { getCLITarget, runPreflight } from '../index.js'
import { evalAgentHook } from '../adapters/claude-code/preflight.js'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('preflight integration: eval agent hook', () => {
  const testDir = join(tmpdir(), 'skill-networks-preflight-test')
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

  it('writes eval-agent.md to .claude/agents/ directory', async () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: .
`)

    const target = getCLITarget('claude-code')
    target.registerPreflight(evalAgentHook)

    await runPreflight(target)

    const agentPath = join(testDir, '.claude', 'agents', 'eval-agent.md')
    expect(existsSync(agentPath)).toBe(true)
  })

  it('creates eval-agent.md with correct YAML frontmatter', async () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: .
`)

    const target = getCLITarget('claude-code')
    target.registerPreflight(evalAgentHook)

    await runPreflight(target)

    const agentPath = join(testDir, '.claude', 'agents', 'eval-agent.md')
    const content = readFileSync(agentPath, 'utf-8')

    // Verify YAML frontmatter structure
    expect(content).toMatch(/^---\n/)
    expect(content).toContain('name: eval-agent')
    expect(content).toContain('description:')
    expect(content).toContain('tools:')
    expect(content).toContain('model: sonnet')
    expect(content).toMatch(/---\n\n/)
  })

  it('is idempotent - does not rewrite unchanged file', async () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: .
`)

    const target = getCLITarget('claude-code')
    target.registerPreflight(evalAgentHook)

    // First run
    await runPreflight(target)

    const agentPath = join(testDir, '.claude', 'agents', 'eval-agent.md')
    const firstContent = readFileSync(agentPath, 'utf-8')

    // Second run
    await runPreflight(target)

    const secondContent = readFileSync(agentPath, 'utf-8')

    expect(secondContent).toBe(firstContent)
  })

  it('updates file when content differs', async () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: .
`)

    // Pre-create agents directory with stale content
    const agentsDir = join(testDir, '.claude', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    const agentPath = join(agentsDir, 'eval-agent.md')
    writeFileSync(agentPath, '# Old content')

    const target = getCLITarget('claude-code')
    target.registerPreflight(evalAgentHook)

    await runPreflight(target)

    const content = readFileSync(agentPath, 'utf-8')

    // Should have been updated with correct content
    expect(content).toContain('name: eval-agent')
    expect(content).not.toContain('# Old content')
  })

  it('does not run for non-claude-code adapters', async () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: .
`)

    const target = getCLITarget('mock')
    target.registerPreflight(evalAgentHook)

    await runPreflight(target)

    // Should not create .claude directory for mock adapter
    const agentPath = join(testDir, '.claude', 'agents', 'eval-agent.md')
    expect(existsSync(agentPath)).toBe(false)
  })
})
