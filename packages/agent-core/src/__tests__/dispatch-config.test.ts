import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

// Mock @duoidal/config so we control what readConfig returns without touching disk
vi.mock('@duoidal/config', () => {
  return {
    readConfig: vi.fn(),
    writeConfig: vi.fn(),
    resolveConfigPath: vi.fn().mockReturnValue(path.join(os.homedir(), '.duoidal', 'config.json')),
    getServer: vi.fn(),
  }
})

// Must import after mock
import { readDispatchConfig } from '../lib/dispatch-config.js'
import * as duoidalConfig from '@duoidal/config'

afterEach(() => {
  vi.resetAllMocks()
  delete process.env.DUOIDAL_CONFIG
})

describe('readDispatchConfig — delegates to readConfig', () => {
  it('returns config with server: self', () => {
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: 'self' })
    const config = readDispatchConfig()
    expect(config.server).toBe('self')
    expect(config.servers).toBeUndefined()
    expect(config.default_link).toBeUndefined()
  })

  it('returns full config with servers and default_link', () => {
    const full = {
      server: 'openclaw',
      servers: {
        openclaw: { host: 'openclaw.example.com', user: 'ubuntu', key: '~/.ssh/id_rsa' }
      },
      default_link: 'agent-efficiency'
    }
    vi.mocked(duoidalConfig.readConfig).mockReturnValue(full)
    const config = readDispatchConfig()
    expect(config.server).toBe('openclaw')
    expect(config.servers?.openclaw.host).toBe('openclaw.example.com')
    expect(config.default_link).toBe('agent-efficiency')
  })

  it('returns servers record when present', () => {
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({
      server: 'myserver',
      servers: {
        myserver: { host: 'example.com', user: 'ubuntu', key: '~/.ssh/id_rsa' }
      }
    })
    const config = readDispatchConfig()
    expect(config.servers?.myserver.host).toBe('example.com')
    expect(config.servers?.myserver.user).toBe('ubuntu')
    expect(config.servers?.myserver.key).toBe('~/.ssh/id_rsa')
  })

  it('propagates errors thrown by readConfig', () => {
    vi.mocked(duoidalConfig.readConfig).mockImplementation(() => { throw new Error('Config at /path/to/config.json must be a JSON object') })
    expect(() => readDispatchConfig()).toThrow()
  })

  it('accepts undefined servers (field absent)', () => {
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: 'self' })
    const config = readDispatchConfig()
    expect(config.servers).toBeUndefined()
  })

  it('accepts a string default_link', () => {
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: 'self', default_link: 'agent-efficiency' })
    const config = readDispatchConfig()
    expect(config.default_link).toBe('agent-efficiency')
  })

  it('accepts undefined default_link (field absent)', () => {
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: 'self' })
    const config = readDispatchConfig()
    expect(config.default_link).toBeUndefined()
  })
})

describe('readDispatchConfig — required field validation', () => {
  it('throws "missing required field: server" when server is absent', () => {
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({} as ReturnType<typeof duoidalConfig.readConfig>)
    expect(() => readDispatchConfig()).toThrow('missing required field: server')
  })

  it('throws "missing required field: server" when server is an empty string', () => {
    vi.mocked(duoidalConfig.readConfig).mockReturnValue({ server: '' })
    expect(() => readDispatchConfig()).toThrow('missing required field: server')
  })
})
