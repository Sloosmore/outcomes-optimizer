import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

// Bypass credential proxy interceptor for localhost BFF calls
process.env['CREDENTIAL_PROXY_BYPASS_URLS'] = 'http://localhost:3001'

const BASE = 'http://localhost:3001'
// Use __nativeFetch if proxy interceptor has already patched globalThis.fetch
const apiFetch: typeof fetch = (globalThis as Record<string, unknown>)['__nativeFetch'] as typeof fetch ?? globalThis.fetch

// Check if the BFF is running
let bffAvailable = false
try {
  const probe = await apiFetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
  bffAvailable = probe.ok
} catch {
  // BFF not running
}

if (!bffAvailable) {
  describe('test:db-artifact-persist', () => {
    it('skipped — BFF not running on port 3001', { skip: true }, () => {})
  })
  describe('test:db-write-read', () => {
    it('skipped — BFF not running on port 3001', { skip: true }, () => {})
  })
} else {

describe('test:db-artifact-persist', () => {
  let chatId: string

  before(() => {
    chatId = ''
  })

  it('POST /api/chats creates chat for artifact test', async () => {
    const res = await apiFetch(`${BASE}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Artifact test chat' }),
    })
    assert.equal(res.status, 201)
    const body = await res.json() as { id: string }
    assert.ok(body.id, 'id should exist')
    chatId = body.id
  })

  const TEST_URL = 'https://artifact-test-3740.duoidal.com/'

  it('PATCH /api/chats/:id/artifact saves url onto rail', async () => {
    const res = await apiFetch(`${BASE}/api/chats/${chatId}/artifact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: TEST_URL }),
    })
    assert.equal(res.status, 200)
    const body = await res.json() as { ok: boolean }
    assert.equal(body.ok, true)
  })

  it('GET /api/chats/:id returns artifactTiles[0].url === TEST_URL', async () => {
    const res = await apiFetch(`${BASE}/api/chats/${chatId}`)
    assert.equal(res.status, 200)
    const body = await res.json() as { artifactTiles: Array<{ url: string }> }
    assert.ok(Array.isArray(body.artifactTiles))
    assert.equal(body.artifactTiles[0]?.url, TEST_URL)
  })
})

describe('test:db-write-read', () => {
  let chatId: string

  before(() => {
    chatId = ''
  })

  it('POST /api/chats creates chat', async () => {
    const res = await apiFetch(`${BASE}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Integration test chat' }),
    })
    assert.equal(res.status, 201)
    const body = await res.json() as { id: string; title: string; createdAt: string }
    assert.ok(body.id, 'id should exist')
    assert.equal(body.title, 'Integration test chat')
    assert.ok(body.createdAt, 'createdAt should exist')
    chatId = body.id
  })

  it('POST /api/chats/:id/messages creates message', async () => {
    const res = await apiFetch(`${BASE}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'Hello integration test' }),
    })
    assert.equal(res.status, 201)
    const body = await res.json() as { id: string; chatId: string; role: string; content: string }
    assert.equal(body.chatId, chatId)
    assert.equal(body.role, 'user')
    assert.equal(body.content, 'Hello integration test')
  })

  it('GET /api/chats/:id/messages returns messages', async () => {
    const res = await apiFetch(`${BASE}/api/chats/${chatId}/messages`)
    assert.equal(res.status, 200)
    const body = await res.json() as Array<{ id: string; chatId: string; role: string; content: string; createdAt: string }>
    assert.ok(Array.isArray(body))
    assert.equal(body.length, 1)
    assert.equal(body[0]?.chatId, chatId)
    assert.equal(body[0]?.role, 'user')
    assert.equal(body[0]?.content, 'Hello integration test')
    assert.ok(body[0]?.createdAt)
  })
})

} // end bffAvailable
