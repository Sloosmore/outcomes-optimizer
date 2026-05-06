import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import os from 'node:os'

let tmpHome: string
let tmpCwd: string
let originalEnv: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'duoidal-home-'))
  tmpCwd = mkdtempSync(join(tmpdir(), 'duoidal-cwd-'))
  originalEnv = process.env['DUOIDAL_CONFIG']
  delete process.env['DUOIDAL_CONFIG']

  // Patch os.homedir() and process.cwd() for isolation
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome)
  vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalEnv !== undefined) {
    process.env['DUOIDAL_CONFIG'] = originalEnv
  } else {
    delete process.env['DUOIDAL_CONFIG']
  }
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(tmpCwd, { recursive: true, force: true })
})

// Re-import after mocks are set up
async function getModule() {
  // Clear module cache to get fresh imports that use the mocked os.homedir/process.cwd
  const { readConfig, writeConfig, resolveConfigPath, getServer } = await import('./index.js')
  return { readConfig, writeConfig, resolveConfigPath, getServer }
}

describe('resolveConfigPath', () => {
  it('returns DUOIDAL_CONFIG env var when set', async () => {
    const { resolveConfigPath } = await getModule()
    const customPath = join(tmpHome, 'custom-config.json')
    process.env['DUOIDAL_CONFIG'] = customPath
    expect(resolveConfigPath()).toBe(customPath)
  })

  it('returns local .duoidal/config.json when it exists', async () => {
    const { resolveConfigPath } = await getModule()
    const localDir = join(tmpCwd, '.duoidal')
    mkdirSync(localDir, { recursive: true })
    const localConfig = join(localDir, 'config.json')
    writeFileSync(localConfig, JSON.stringify({ server: 'local' }), 'utf-8')
    expect(resolveConfigPath()).toBe(localConfig)
  })

  it('returns global ~/.duoidal/config.json when no local or env var', async () => {
    const { resolveConfigPath } = await getModule()
    const globalPath = join(tmpHome, '.duoidal', 'config.json')
    expect(resolveConfigPath()).toBe(globalPath)
  })
})

describe('readConfig — local-first resolution', () => {
  it('local .duoidal/config.json beats global ~/.duoidal/config.json', async () => {
    const { readConfig } = await getModule()

    // Create global config
    const globalDir = join(tmpHome, '.duoidal')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({ server: 'global' }), 'utf-8')

    // Create local config
    const localDir = join(tmpCwd, '.duoidal')
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'config.json'), JSON.stringify({ server: 'local' }), 'utf-8')

    const config = readConfig()
    expect(config.server).toBe('local')
  })

  it('falls back to global when no local config exists', async () => {
    const { readConfig } = await getModule()

    const globalDir = join(tmpHome, '.duoidal')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({ server: 'global-only' }), 'utf-8')

    const config = readConfig()
    expect(config.server).toBe('global-only')
  })
})

describe('readConfig — DUOIDAL_CONFIG env var', () => {
  it('$DUOIDAL_CONFIG beats both local and global configs', async () => {
    const { readConfig } = await getModule()

    // Create global config
    const globalDir = join(tmpHome, '.duoidal')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({ server: 'global' }), 'utf-8')

    // Create local config
    const localDir = join(tmpCwd, '.duoidal')
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'config.json'), JSON.stringify({ server: 'local' }), 'utf-8')

    // Create env config
    const envConfig = join(tmpHome, 'env-config.json')
    writeFileSync(envConfig, JSON.stringify({ server: 'env-override' }), 'utf-8')
    process.env['DUOIDAL_CONFIG'] = envConfig

    const config = readConfig()
    expect(config.server).toBe('env-override')
  })
})

describe('readConfig — auto-create', () => {
  it('creates ~/.duoidal/config.json with { server: "self" } when nothing exists', async () => {
    const { readConfig } = await getModule()

    // No local or global config exists
    const config = readConfig()

    expect(config.server).toBe('self')

    // Verify the file was created at the global path
    const globalConfigPath = join(tmpHome, '.duoidal', 'config.json')
    expect(existsSync(globalConfigPath)).toBe(true)

    const written = JSON.parse(readFileSync(globalConfigPath, 'utf-8')) as { server: string }
    expect(written.server).toBe('self')
  })
})

describe('writeConfig', () => {
  it('writes to local path when local config exists', async () => {
    const { writeConfig } = await getModule()

    // Create local config
    const localDir = join(tmpCwd, '.duoidal')
    mkdirSync(localDir, { recursive: true })
    const localConfigPath = join(localDir, 'config.json')
    writeFileSync(localConfigPath, JSON.stringify({ server: 'local' }), 'utf-8')

    writeConfig({ server: 'updated-local' })

    const written = JSON.parse(readFileSync(localConfigPath, 'utf-8')) as { server: string }
    expect(written.server).toBe('updated-local')
  })

  it('writes to global path when no local config exists', async () => {
    const { writeConfig } = await getModule()

    writeConfig({ server: 'global-write' })

    const globalConfigPath = join(tmpHome, '.duoidal', 'config.json')
    expect(existsSync(globalConfigPath)).toBe(true)
    const written = JSON.parse(readFileSync(globalConfigPath, 'utf-8')) as { server: string }
    expect(written.server).toBe('global-write')
  })

  it('atomic write: file is valid JSON even after two sequential writes', async () => {
    const { writeConfig } = await getModule()

    const globalConfigPath = join(tmpHome, '.duoidal', 'config.json')

    // Two sequential writes — both are synchronous, test that final state is valid
    writeConfig({ server: 'first-write' })
    writeConfig({ server: 'second-write' })

    expect(existsSync(globalConfigPath)).toBe(true)
    const written = JSON.parse(readFileSync(globalConfigPath, 'utf-8')) as { server: string }
    expect(written.server).toBe('second-write')
  })

  it('atomic write: no .tmp file left behind after write', async () => {
    const { writeConfig } = await getModule()

    writeConfig({ server: 'test' })

    const globalConfigPath = join(tmpHome, '.duoidal', 'config.json')
    expect(existsSync(globalConfigPath + '.tmp')).toBe(false)
    expect(existsSync(globalConfigPath)).toBe(true)
  })
})

describe('getServer', () => {
  it('returns server entry by name', async () => {
    const { getServer } = await getModule()

    const globalDir = join(tmpHome, '.duoidal')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(
      join(globalDir, 'config.json'),
      JSON.stringify({
        server: 'prod',
        servers: {
          prod: { host: '1.2.3.4', user: 'root', key: '/home/user/.ssh/id_rsa' },
        },
      }),
      'utf-8'
    )

    const server = getServer('prod')
    expect(server).not.toBeNull()
    expect(server?.host).toBe('1.2.3.4')
    expect(server?.user).toBe('root')
    expect(server?.key).toBe('/home/user/.ssh/id_rsa')
  })

  it('returns null when server name not found', async () => {
    const { getServer } = await getModule()

    const globalDir = join(tmpHome, '.duoidal')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(
      join(globalDir, 'config.json'),
      JSON.stringify({ server: 'prod', servers: {} }),
      'utf-8'
    )

    const server = getServer('nonexistent')
    expect(server).toBeNull()
  })

  it('returns null when no servers key in config', async () => {
    const { getServer } = await getModule()

    const globalDir = join(tmpHome, '.duoidal')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(
      join(globalDir, 'config.json'),
      JSON.stringify({ server: 'self' }),
      'utf-8'
    )

    const server = getServer('anything')
    expect(server).toBeNull()
  })
})
