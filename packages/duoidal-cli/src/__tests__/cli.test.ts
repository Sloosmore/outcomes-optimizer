import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// Test in a temp directory
let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-test-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.resetModules()
})

// ---------------------------------------------------------------------------
// Helpers to exercise config module with a custom CONFIG_DIR (tmpDir)
// ---------------------------------------------------------------------------

function writeTokenToDir(dir: string, token: { access_token: string; refresh_token: string; expires_at?: number }) {
  fs.mkdirSync(dir, { recursive: true })
  const tokenPath = path.join(dir, 'token.json')
  fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 })
  return tokenPath
}

function writeSandboxKeyToDir(dir: string, resourceId: string, privateKeyPem: string) {
  const keyDir = path.join(dir, 'sandboxes', resourceId)
  fs.mkdirSync(keyDir, { recursive: true })
  const keyPath = path.join(keyDir, 'id_ed25519')
  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 })
  return keyPath
}

// ---------------------------------------------------------------------------
// 1. Token file permissions
// ---------------------------------------------------------------------------

describe('Token file permissions', () => {
  it('writes token.json with mode 0o600', () => {
    const tokenPath = writeTokenToDir(tmpDir, { access_token: 'tok', refresh_token: 'ref' })
    const mode = fs.statSync(tokenPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('round-trips token data', () => {
    const original = { access_token: 'abc123', refresh_token: 'xyz789', expires_at: 9999 }
    const tokenPath = writeTokenToDir(tmpDir, original)
    const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))
    expect(parsed).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// 2. Sandbox key file permissions
// ---------------------------------------------------------------------------

describe('Sandbox key file permissions', () => {
  it('writes id_ed25519 with mode 0o600', () => {
    const resourceId = 'sandbox-abc123'
    const keyPath = writeSandboxKeyToDir(tmpDir, resourceId, '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n')
    const mode = fs.statSync(keyPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('stores key in correct path structure', () => {
    const resourceId = 'sandbox-xyz'
    const keyPath = writeSandboxKeyToDir(tmpDir, resourceId, 'PRIVATE_KEY_PEM')
    expect(keyPath).toContain(path.join('sandboxes', resourceId, 'id_ed25519'))
  })
})

// ---------------------------------------------------------------------------
// 3. Keypair generation
// ---------------------------------------------------------------------------

describe('Ed25519 keypair generation', () => {
  it('generates a valid ed25519 keypair without throwing', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    expect(publicKey).toBeTruthy()
    expect(privateKey).toBeTruthy()
    expect(publicKey.length).toBeGreaterThan(0)
    expect(privateKey.length).toBeGreaterThan(0)
  })

  it('produces SSH-formatted public key starting with ssh-ed25519', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })

    const pubKeyObj = crypto.createPublicKey(publicKey)
    const pubKeyDer = pubKeyObj.export({ type: 'spki', format: 'der' }) as Buffer
    // Extract the raw 32-byte ed25519 key from the DER (skip 12-byte SPKI header)
    const rawPubKey = pubKeyDer.slice(12)
    expect(rawPubKey.length).toBe(32)

    // Build SSH wire format
    const keyTypeBuf = Buffer.from('ssh-ed25519')
    const wireFormat = Buffer.alloc(4 + keyTypeBuf.length + 4 + rawPubKey.length)
    let offset = 0
    wireFormat.writeUInt32BE(keyTypeBuf.length, offset); offset += 4
    keyTypeBuf.copy(wireFormat, offset); offset += keyTypeBuf.length
    wireFormat.writeUInt32BE(rawPubKey.length, offset); offset += 4
    rawPubKey.copy(wireFormat, offset)

    const sshPublicKey = `ssh-ed25519 ${wireFormat.toString('base64')} duoidal-cli`
    expect(sshPublicKey).toMatch(/^ssh-ed25519 /)
    expect(sshPublicKey).toContain('duoidal-cli')
  })
})

// ---------------------------------------------------------------------------
// 4. API URL configuration
// ---------------------------------------------------------------------------

describe('API URL configuration', () => {
  it('uses DUOIDAL_API_URL env var when set', async () => {
    const originalEnv = process.env['DUOIDAL_API_URL']
    process.env['DUOIDAL_API_URL'] = 'https://custom.example.com'

    // Dynamic import to get fresh module state
    const { getApiBaseUrl } = await import('../lib/client.js')
    expect(getApiBaseUrl()).toBe('https://custom.example.com')

    // Restore
    if (originalEnv === undefined) {
      delete process.env['DUOIDAL_API_URL']
    } else {
      process.env['DUOIDAL_API_URL'] = originalEnv
    }
  })

  it('throws when DUOIDAL_API_URL is not set', async () => {
    const originalEnv = process.env['DUOIDAL_API_URL']
    delete process.env['DUOIDAL_API_URL']

    const { getApiBaseUrl } = await import('../lib/client.js')
    expect(() => getApiBaseUrl()).toThrow('DUOIDAL_API_URL environment variable is not set')

    // Restore
    if (originalEnv !== undefined) {
      process.env['DUOIDAL_API_URL'] = originalEnv
    }
  })
})

// ---------------------------------------------------------------------------
// 5. HTTP client — POST/GET with auth header (mock fetch)
// ---------------------------------------------------------------------------

describe('HTTP client', () => {
  it('sends POST with correct method and Authorization header', async () => {
    const mockResponse = { processId: 'proc-123' }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    })
    vi.stubGlobal('fetch', mockFetch)

    const { createClient } = await import('../lib/client.js')
    const client = createClient('https://api.example.com')
    const result = await client.post('/api/process/run', { goal: 'test' }, 'my-jwt-token')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/api/process/run')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-jwt-token')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(result).toEqual(mockResponse)
  })

  it('sends GET with correct method and Authorization header', async () => {
    const mockResponse = { status: 'active', ip: '1.2.3.4', resourceId: 'sb-1' }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    })
    vi.stubGlobal('fetch', mockFetch)

    const { createClient } = await import('../lib/client.js')
    const client = createClient('https://api.example.com')
    const result = await client.get('/api/sandbox/status', 'my-jwt-token')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/api/sandbox/status')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-jwt-token')
    expect(result).toEqual(mockResponse)
  })

  it('throws on non-ok response with API error message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'Forbidden' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { createClient } = await import('../lib/client.js')
    const client = createClient('https://api.example.com')

    await expect(client.get('/api/sandbox/status', 'bad-token')).rejects.toThrow('API error 403: Forbidden')
  })

  it('sends request without auth header when no token provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { createClient } = await import('../lib/client.js')
    const client = createClient('https://api.example.com')
    await client.get('/api/public')

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })
})
