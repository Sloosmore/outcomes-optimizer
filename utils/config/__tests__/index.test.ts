import { loadConfig, configSchema } from '../index.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('loadConfig', () => {
  const testDir = join(tmpdir(), 'skill-networks-config-test')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('loads valid config successfully', () => {
    const configPath = join(testDir, 'config.yaml')
    writeFileSync(configPath, `
campaign:
  name: test-experiment
database:
  adapter: none
cli:
  adapter: claude-code
`)

    const config = loadConfig(configPath)

    expect(config.campaign.name).toBe('test-experiment')
    expect(config.database.adapter).toBe('none')
    expect(config.cli.adapter).toBe('claude-code')
  })

  it('throws descriptive error when file is missing', () => {
    const configPath = join(testDir, 'nonexistent.yaml')

    expect(() => loadConfig(configPath)).toThrow(`Config file not found: ${configPath}`)
  })

  it('throws error for invalid YAML', () => {
    const configPath = join(testDir, 'invalid.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
  bad indentation here
`)

    expect(() => loadConfig(configPath)).toThrow()
  })

  it('throws error when required fields are missing', () => {
    const configPath = join(testDir, 'missing-fields.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
`)

    expect(() => loadConfig(configPath)).toThrow('Invalid config')
    expect(() => loadConfig(configPath)).toThrow('cli')
  })

  it('throws error for invalid database adapter enum value', () => {
    const configPath = join(testDir, 'invalid-db.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: postgres
cli:
  adapter: claude-code
`)

    expect(() => loadConfig(configPath)).toThrow('Invalid config')
    expect(() => loadConfig(configPath)).toThrow('database.adapter')
  })

  it('throws error for invalid cli adapter enum value', () => {
    const configPath = join(testDir, 'invalid-cli.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: gpt
`)

    expect(() => loadConfig(configPath)).toThrow('Invalid config')
    expect(() => loadConfig(configPath)).toThrow('cli.adapter')
  })

  it('throws error when campaign name is empty', () => {
    const configPath = join(testDir, 'empty-name.yaml')
    writeFileSync(configPath, `
campaign:
  name: ""
database:
  adapter: none
cli:
  adapter: claude-code
`)

    expect(() => loadConfig(configPath)).toThrow('Invalid config')
    expect(() => loadConfig(configPath)).toThrow('campaign.name')
  })

  it('throws error when workingDir is empty string', () => {
    const configPath = join(testDir, 'empty-path.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: claude-code
  workingDir: ""
`)

    expect(() => loadConfig(configPath)).toThrow('Invalid config')
    expect(() => loadConfig(configPath)).toThrow('cli.workingDir')
  })

  it('accepts all valid database adapter values', () => {
    const adapters = ['none', 'local', 'cloud'] as const

    for (const adapter of adapters) {
      const configPath = join(testDir, `db-${adapter}.yaml`)
      writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: ${adapter}
cli:
  adapter: claude-code
`)

      const config = loadConfig(configPath)
      expect(config.database.adapter).toBe(adapter)
    }
  })

  it('accepts all valid cli adapter values', () => {
    const adapters = ['claude-code', 'codex', 'mock'] as const

    for (const adapter of adapters) {
      const configPath = join(testDir, `cli-${adapter}.yaml`)
      writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: ${adapter}
`)

      const config = loadConfig(configPath)
      expect(config.cli.adapter).toBe(adapter)
    }
  })
})

describe('configSchema', () => {
  it('exports schema for external use', () => {
    expect(configSchema).toBeDefined()
    expect(typeof configSchema.safeParse).toBe('function')
  })

  it('schema validates correct structure', () => {
    const result = configSchema.safeParse({
      campaign: { name: 'test' },
      database: { adapter: 'none' },
      cli: { adapter: 'mock' },
    })

    expect(result.success).toBe(true)
  })

  it('schema rejects incorrect structure', () => {
    const result = configSchema.safeParse({
      campaign: { name: 'test' },
      database: { adapter: 'invalid' },
      cli: { adapter: 'mock' },
    })

    expect(result.success).toBe(false)
  })
})
