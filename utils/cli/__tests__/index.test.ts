import { getCLITarget } from '../index.js'
import { CLAUDE_MODEL } from '../../types.js'
import { writeFileSync, mkdirSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

describe('getCLITarget', () => {
  const testDir = join(tmpdir(), 'skill-networks-cli-test')
  const originalCwd = process.cwd()

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns claude-code target for claude-code adapter', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
`)

    const target = getCLITarget()

    expect(target.name).toBe('claude-code')
    expect(target.skillsDir).toBe(join(homedir(), '.claude', 'skills'))
    expect(target.envVar).toBe('ANTHROPIC_API_KEY')
  })

  it('returns codex target for codex adapter', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: codex
`)

    const target = getCLITarget()

    expect(target.name).toBe('codex')
    // Codex uses .agents/skills for skill discovery (not .codex/skills)
    expect(target.skillsDir).toBe(join(homedir(), '.agents', 'skills'))
    expect(target.envVar).toBe('OPENAI_API_KEY')
  })

  it('returns mock target for mock adapter', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
`)

    const target = getCLITarget()

    expect(target.name).toBe('mock')
    expect(target.skillsDir).toBe(join(homedir(), '.mock', 'skills'))
    expect(target.configDir).toBe(join(homedir(), '.mock'))
    expect(target.envVar).toBe('')
  })

  it('allows adapter override', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
`)

    const target = getCLITarget('mock')

    expect(target.name).toBe('mock')
  })
})

describe('CLITarget.buildCommand', () => {
  const testDir = join(tmpdir(), 'skill-networks-cli-cmd-test')
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
`)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('builds correct command for claude-code', () => {
    const target = getCLITarget('claude-code')
    const command = target.buildCommand('test prompt')

    expect(command[0]).toBe('claude')
    expect(command[1]).toBe('-p')
    // Prompt is passed directly - caller is responsible for composition
    expect(command[2]).toBe('test prompt')
    // Permissions are written to .claude/settings.json by the preflight hook,
    // not passed via --settings flag (which does not set permissionMode).
    expect(command.slice(3)).toEqual([
      '--model', CLAUDE_MODEL,
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'Write,Edit,Read,Bash,Glob,Grep,WebFetch,WebSearch,Agent,Skill,TodoWrite,TodoRead,NotebookEdit,NotebookRead,mcp__*',
    ])
  })

  it('builds correct command for codex', () => {
    const target = getCLITarget('codex')
    const command = target.buildCommand('test prompt')

    expect(command).toEqual([
      'codex',
      'exec', 'test prompt',
      '--model', 'gpt-5.2-codex',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json'
    ])
  })

  it('builds correct command for mock', () => {
    const target = getCLITarget('mock')
    const command = target.buildCommand('test prompt')

    expect(command[0]).toBe('echo')
    expect(command[1]).toContain('test prompt')
  })
})

describe('CLITarget.parseOutput', () => {
  const testDir = join(tmpdir(), 'skill-networks-cli-parse-test')
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
`)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('parses claude-code JSONL output', () => {
    const target = getCLITarget('claude-code')
    const stdout = `{"type":"init","session_id":"abc123"}
{"type":"result","session_id":"abc123","is_error":false,"total_cost_usd":0.05}`

    const output = target.parseOutput!(stdout)

    expect(output.sessionId).toBe('abc123')
    expect(output.success).toBe(true)
    expect(output.cost).toBe(0.05)
  })

  it('parses codex JSONL output', () => {
    const target = getCLITarget('codex')
    // Codex outputs JSONL with thread.started and turn.completed events
    const stdout = `{"type":"thread.started","thread_id":"xyz789"}
{"type":"turn.completed"}`

    const output = target.parseOutput!(stdout)

    expect(output.sessionId).toBe('xyz789')
    expect(output.success).toBe(true)
  })

  it('handles empty output gracefully', () => {
    const target = getCLITarget('claude-code')
    const output = target.parseOutput!('')

    expect(output.success).toBe(false)
    expect(output.error).toBeDefined()
  })

  it('handles invalid JSON gracefully', () => {
    const target = getCLITarget('codex')
    const output = target.parseOutput!('not valid json')

    expect(output.success).toBe(false)
    expect(output.error).toContain('parse')
  })

  it('parses mock JSON output', () => {
    const target = getCLITarget('mock')
    const stdout = '{"session_id":"mock-123","success":true}'

    const output = target.parseOutput!(stdout)

    expect(output.sessionId).toBe('mock-123')
    expect(output.success).toBe(true)
  })

  it('mock handles empty output gracefully', () => {
    const target = getCLITarget('mock')
    const output = target.parseOutput!('')

    expect(output.success).toBe(false)
    expect(output.error).toBeDefined()
  })

  it('mock handles invalid JSON gracefully', () => {
    const target = getCLITarget('mock')
    const output = target.parseOutput!('not valid json')

    expect(output.success).toBe(false)
    expect(output.error).toContain('parse')
  })

  it('mock respects success field in output', () => {
    const target = getCLITarget('mock')
    const stdout = '{"session_id":"mock-456","success":false,"error":"something failed"}'

    const output = target.parseOutput!(stdout)

    expect(output.sessionId).toBe('mock-456')
    expect(output.success).toBe(false)
    expect(output.error).toBe('something failed')
  })
})

describe('getCLITarget with workingDir', () => {
  const testDir = join(tmpdir(), 'skill-networks-cli-path-test')
  const originalCwd = process.cwd()

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('uses homedir when workingDir is undefined', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
`)

    const target = getCLITarget()
    expect(target.skillsDir).toBe(join(homedir(), '.claude', 'skills'))
  })

  it('uses workspace root when workingDir is "."', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: .
`)

    const target = getCLITarget()
    // Use realpathSync to handle symlinks (e.g., /var -> /private/var on macOS)
    expect(target.skillsDir).toBe(join(realpathSync(testDir), '.claude', 'skills'))
  })

  it('uses absolute path when provided', () => {
    const absolutePath = '/workspace'
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: codex
  workingDir: ${absolutePath}
`)

    const target = getCLITarget('codex')
    // Codex uses .agents/skills for skill discovery
    expect(target.skillsDir).toBe(join(absolutePath, '.agents', 'skills'))
  })

  it('resolves relative paths from workspace', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: custom/path
`)

    const target = getCLITarget('mock')
    // Use realpathSync to handle symlinks (e.g., /var -> /private/var on macOS)
    expect(target.skillsDir).toBe(join(realpathSync(testDir), 'custom/path', '.mock', 'skills'))
  })

  it('throws error when relative path escapes workspace', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: ../../outside
`)

    expect(() => getCLITarget('mock')).toThrow('workingDir cannot escape workspace')
    expect(() => getCLITarget('mock')).toThrow('../../outside')
  })

  it('uses process.cwd() as workingDir when workingDir is undefined', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
`)

    const target = getCLITarget()
    expect(target.workingDir).toBe(realpathSync(process.cwd()))
  })

  it('uses baseDir as workingDir when workingDir is set', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: .
`)

    const target = getCLITarget()
    expect(target.workingDir).toBe(realpathSync(testDir))
  })

  it('uses baseDir as workingDir for relative paths', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
  workingDir: custom/path
`)

    const target = getCLITarget('mock')
    expect(target.workingDir).toBe(join(realpathSync(testDir), 'custom/path'))
  })
})
