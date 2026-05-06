import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

// Mock node:fs so file operations can be controlled per test.
//
// IMPORTANT: write-side mocks default to no-ops, NOT pass-throughs to the real fs. Using
// `vi.fn(actual.writeFileSync)` would retain the real implementation as the default, allowing
// any test that exercises `writeLocalToken` to overwrite the developer's real
// `~/.config/duoidal/token.json` with a test fixture (sub: 'user-...', refresh_token:
// 'new-refresh-token'). Read-side defaults to ENOENT for the same reason. See PR
// "fix(tests): isolate token-write tests from real-fs".
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const safeReadFileSync = vi.fn(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  const safeWriteFileSync = vi.fn(() => undefined)
  const safeMkdirSync = vi.fn(() => undefined)
  const safeRenameSync = vi.fn(() => undefined)
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: safeReadFileSync,
      writeFileSync: safeWriteFileSync,
      mkdirSync: safeMkdirSync,
      renameSync: safeRenameSync,
    },
    readFileSync: safeReadFileSync,
    writeFileSync: safeWriteFileSync,
    mkdirSync: safeMkdirSync,
    renameSync: safeRenameSync,
  }
})

import fs from 'node:fs'
const mockReadFileSync = vi.mocked(fs.readFileSync)
const mockWriteFileSync = vi.mocked(fs.writeFileSync)
const mockMkdirSync = vi.mocked(fs.mkdirSync)
const mockRenameSync = vi.mocked(fs.renameSync)

const TOKEN_PATH = path.join(os.homedir(), '.config', 'duoidal', 'token.json')

// Helper to build a JWT with given claims
function buildJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.fake-signature`
}

describe('identity — parseJwtSub', () => {
  let parseJwtSub: typeof import('../lib/identity.js').parseJwtSub

  beforeEach(async () => {
    const mod = await import('../lib/identity.js')
    parseJwtSub = mod.parseJwtSub
  })

  it('returns sub from valid non-expired JWT', () => {
    const jwt = buildJwt({ sub: '00000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600 })
    expect(parseJwtSub(jwt)).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('returns null for expired JWT', () => {
    const jwt = buildJwt({ sub: '00000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now() / 1000) - 3600 })
    expect(parseJwtSub(jwt)).toBeNull()
  })

  it('returns null for malformed token', () => {
    expect(parseJwtSub('not-a-jwt')).toBeNull()
  })
})

describe('identity — parseJwtSubUnchecked', () => {
  let parseJwtSubUnchecked: typeof import('../lib/identity.js').parseJwtSubUnchecked

  beforeEach(async () => {
    const mod = await import('../lib/identity.js')
    parseJwtSubUnchecked = mod.parseJwtSubUnchecked
  })

  it('returns sub from expired JWT', () => {
    const jwt = buildJwt({ sub: '00000000-0000-4000-8000-000000000002', exp: Math.floor(Date.now() / 1000) - 3600 })
    expect(parseJwtSubUnchecked(jwt)).toBe('00000000-0000-4000-8000-000000000002')
  })

  it('returns sub from valid JWT', () => {
    const jwt = buildJwt({ sub: '00000000-0000-4000-8000-000000000003', exp: Math.floor(Date.now() / 1000) + 3600 })
    expect(parseJwtSubUnchecked(jwt)).toBe('00000000-0000-4000-8000-000000000003')
  })

  it('returns null for malformed token (no payload)', () => {
    expect(parseJwtSubUnchecked('header-only')).toBeNull()
  })
})

describe('identity — readLocalToken', () => {
  let readLocalToken: typeof import('../lib/identity.js').readLocalToken

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../lib/identity.js')
    readLocalToken = mod.readLocalToken
  })

  it('returns null when file does not exist', () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath === TOKEN_PATH) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
    expect(readLocalToken()).toBeNull()
  })

  it('returns parsed token when file exists', () => {
    const tokenData = { access_token: 'abc.def.ghi', refresh_token: 'rt' }
    mockReadFileSync.mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath === TOKEN_PATH) {
        return JSON.stringify(tokenData)
      }
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
    expect(readLocalToken()).toEqual(tokenData)
  })
})

describe('identity — isTokenExpired', () => {
  let isTokenExpired: typeof import('../lib/identity.js').isTokenExpired

  beforeEach(async () => {
    const mod = await import('../lib/identity.js')
    isTokenExpired = mod.isTokenExpired
  })

  it('returns true for expired token (past exp)', () => {
    const jwt = buildJwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 3600 })
    expect(isTokenExpired(jwt)).toBe(true)
  })

  it('returns false for valid token with exp far in future', () => {
    const jwt = buildJwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 3600 })
    expect(isTokenExpired(jwt)).toBe(false)
  })

  it('respects bufferSeconds — token expiring soon within buffer is treated as expired', () => {
    const jwt = buildJwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 30 })
    expect(isTokenExpired(jwt, 60)).toBe(true)
  })

  it('returns false for token with no exp claim (non-rotating machine token)', () => {
    const jwt = buildJwt({ sub: 'u' })
    expect(isTokenExpired(jwt)).toBe(false)
  })

  it('returns true for malformed token', () => {
    expect(isTokenExpired('not-a-jwt')).toBe(true)
  })
})

describe('identity — writeLocalToken', () => {
  let writeLocalToken: typeof import('../lib/identity.js').writeLocalToken

  beforeEach(async () => {
    vi.clearAllMocks()
    mockMkdirSync.mockImplementation(() => undefined as unknown as string)
    mockWriteFileSync.mockImplementation(() => undefined)
    mockRenameSync.mockImplementation(() => undefined)
    const mod = await import('../lib/identity.js')
    writeLocalToken = mod.writeLocalToken
  })

  it('creates directory, writes to tmp file, and atomically renames', () => {
    const data = { access_token: 'at', refresh_token: 'rt' }
    writeLocalToken(data)

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.config/duoidal'),
      expect.objectContaining({ recursive: true, mode: 0o700 })
    )
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp.'),
      JSON.stringify(data, null, 2),
      expect.objectContaining({ encoding: 'utf-8', mode: 0o600 })
    )
    const tmpPath = (mockWriteFileSync.mock.calls[0] as string[])[0]
    expect(mockRenameSync).toHaveBeenCalledWith(tmpPath, TOKEN_PATH)
  })

  it('writes with mode 0o600 for file permissions', () => {
    writeLocalToken({ access_token: 'at' })
    const writeOpts = mockWriteFileSync.mock.calls[0]?.[2] as { mode?: number }
    expect(writeOpts?.mode).toBe(0o600)
  })

  it('serializes all provided fields including expires_at', () => {
    const data = { access_token: 'at', refresh_token: 'rt', expires_at: 9999 }
    writeLocalToken(data)
    const written = JSON.parse((mockWriteFileSync.mock.calls[0] as string[])[1])
    expect(written).toEqual(data)
  })
})

describe('identity — getLocalSub', () => {
  let getLocalSub: typeof import('../lib/identity.js').getLocalSub
  const originalEnv = { ...process.env }

  beforeEach(async () => {
    vi.clearAllMocks()
    delete process.env.DUOIDAL_TOKEN
    const mod = await import('../lib/identity.js')
    getLocalSub = mod.getLocalSub
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it('returns null when no token is available', () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath === TOKEN_PATH) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
    expect(getLocalSub()).toBeNull()
  })

  it('returns sub from valid token', () => {
    const sub = 'local-sub-001'
    const jwt = buildJwt({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })
    process.env.DUOIDAL_TOKEN = jwt
    expect(getLocalSub()).toBe(sub)
  })
})

describe('identity — getLocalSubUnchecked', () => {
  let getLocalSubUnchecked: typeof import('../lib/identity.js').getLocalSubUnchecked
  const originalEnv = { ...process.env }

  beforeEach(async () => {
    vi.clearAllMocks()
    delete process.env.DUOIDAL_TOKEN
    const mod = await import('../lib/identity.js')
    getLocalSubUnchecked = mod.getLocalSubUnchecked
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it('returns null when no token is available', () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath === TOKEN_PATH) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
    expect(getLocalSubUnchecked()).toBeNull()
  })

  it('returns sub from expired token (does not check expiry)', () => {
    const sub = 'expired-sub-001'
    const jwt = buildJwt({ sub, exp: Math.floor(Date.now() / 1000) - 3600 })
    process.env.DUOIDAL_TOKEN = jwt
    expect(getLocalSubUnchecked()).toBe(sub)
  })

  it('returns sub from valid token', () => {
    const sub = 'valid-sub-001'
    const jwt = buildJwt({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })
    process.env.DUOIDAL_TOKEN = jwt
    expect(getLocalSubUnchecked()).toBe(sub)
  })

  it('returns sub from token file when no env var set', () => {
    const sub = 'file-sub-001'
    const jwt = buildJwt({ sub, exp: Math.floor(Date.now() / 1000) - 3600 })
    const tokenData = { access_token: jwt }
    mockReadFileSync.mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath === TOKEN_PATH) {
        return JSON.stringify(tokenData)
      }
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' })
    })
    expect(getLocalSubUnchecked()).toBe(sub)
  })
})
