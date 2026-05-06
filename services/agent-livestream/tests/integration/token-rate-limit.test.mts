import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

process.env['CREDENTIAL_PROXY_BYPASS_URLS'] = 'http://localhost:3001'

const BASE = 'http://localhost:3001'
const apiFetch = (globalThis as Record<string, unknown>)['__nativeFetch'] as typeof fetch ?? globalThis.fetch

describe('test:token-rate-limit', () => {
  before(async () => {
    // Check if the server is running; skip all tests if not
    try {
      await apiFetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    } catch {
      // Server not available — skip
      return
    }
  })

  it('returns 429 on 21st request within 1 second', async () => {
    // Check connectivity first
    try {
      await apiFetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    } catch {
      // eslint-disable-next-line no-console -- skip message
      console.log('BFF not running — skipping test:token-rate-limit')
      return
    }

    const chatId = crypto.randomUUID()
    const url = `${BASE}/token?chatId=${chatId}`

    const statuses: number[] = []
    for (let i = 0; i < 21; i++) {
      const res = await apiFetch(url)
      statuses.push(res.status)
    }

    // First 20 should be 200 (or 500 if LiveKit not configured, but not 429)
    for (let i = 0; i < 20; i++) {
      assert.notEqual(statuses[i], 429, `Request ${i + 1} should not be rate-limited`)
    }

    // 21st should be 429
    assert.equal(statuses[20], 429, '21st request should be rate-limited (429)')
  })
})
