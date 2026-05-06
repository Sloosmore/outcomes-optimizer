import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock postgres to avoid real connections
vi.mock('postgres', () => ({
  default: vi.fn((url: string) => {
    const mock = Object.assign((() => []) as unknown as ReturnType<typeof import('postgres').default>, {
      end: vi.fn(),
      _url: url,
    })
    return mock
  }),
}))

describe('getSqlClient — connection resolution', () => {
  let originalEnv: Record<string, string | undefined>
  let tmpDir: string

  beforeEach(async () => {
    originalEnv = {
      SKILL_NETWORKS_DATABASE_URL: process.env['SKILL_NETWORKS_DATABASE_URL'],
      DATABASE_URL: process.env['DATABASE_URL'],
    }
    delete process.env['SKILL_NETWORKS_DATABASE_URL']
    delete process.env['DATABASE_URL']
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-test-'))

    // Reset module state between tests
    const mod = await import('../client.js')
    await mod.closeSqlClient()
    vi.resetModules()
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses SKILL_NETWORKS_DATABASE_URL when set', async () => {
    process.env['SKILL_NETWORKS_DATABASE_URL'] = 'postgresql://direct:5432/db'
    const { getSqlClient, closeSqlClient } = await import('../client.js')
    const client = getSqlClient() as unknown as { _url: string }
    expect(client._url).toBe('postgresql://direct:5432/db')
    await closeSqlClient()
  })

  it('uses DATABASE_URL as fallback', async () => {
    process.env['DATABASE_URL'] = 'postgresql://fallback:5432/db'
    const { getSqlClient, closeSqlClient } = await import('../client.js')
    const client = getSqlClient() as unknown as { _url: string }
    expect(client._url).toBe('postgresql://fallback:5432/db')
    await closeSqlClient()
  })

  it('SKILL_NETWORKS_DATABASE_URL takes priority over DATABASE_URL', async () => {
    process.env['SKILL_NETWORKS_DATABASE_URL'] = 'postgresql://primary:5432/db'
    process.env['DATABASE_URL'] = 'postgresql://secondary:5432/db'
    const { getSqlClient, closeSqlClient } = await import('../client.js')
    const client = getSqlClient() as unknown as { _url: string }
    expect(client._url).toBe('postgresql://primary:5432/db')
    await closeSqlClient()
  })

  it('constructs Supavisor URL from local JWT when no env var', async () => {
    // Write a valid JWT to a temp token path
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'test-user', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
    const jwt = `${header}.${payload}.fake-signature`

    // Mock os.homedir to use tmpDir
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    const configDir = path.join(tmpDir, '.config', 'duoidal')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'token.json'), JSON.stringify({ access_token: jwt }))

    process.env.SUPABASE_PROJECT_REF = 'test-project-ref'
    const { getSqlClient, closeSqlClient } = await import('../client.js')
    const client = getSqlClient() as unknown as { _url: string }
    expect(client._url).toContain('authenticated.test-project-ref')
    expect(client._url).toContain(jwt)
    expect(client._url).toContain('pooler.supabase.com:6543')
    await closeSqlClient()
    homedirSpy.mockRestore()
  })

  it('rejects expired JWT and throws', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'test-user', exp: 1000000000 })).toString('base64url')
    const jwt = `${header}.${payload}.fake-signature`

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    const configDir = path.join(tmpDir, '.config', 'duoidal')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'token.json'), JSON.stringify({ access_token: jwt }))

    const { getSqlClient } = await import('../client.js')
    expect(() => getSqlClient()).toThrow('No database connection available')
    homedirSpy.mockRestore()
  })

  it('throws when no env var and no token file', async () => {
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    const { getSqlClient } = await import('../client.js')
    expect(() => getSqlClient()).toThrow('No database connection available')
    homedirSpy.mockRestore()
  })
})
