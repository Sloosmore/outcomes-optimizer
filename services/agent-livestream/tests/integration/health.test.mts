import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env['CREDENTIAL_PROXY_BYPASS_URLS'] = 'http://localhost:3001'

const BASE = 'http://localhost:3001'
const apiFetch =
  ((globalThis as Record<string, unknown>)['__nativeFetch'] as typeof fetch) ??
  globalThis.fetch

describe('test:health', () => {
  it('GET /health returns 200 with db, ssh, livekit status', async () => {
    try {
      await apiFetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    } catch {
      // eslint-disable-next-line no-console -- skip message
      console.log('# BFF not running — skipping test:health')
      return
    }

    const res = await apiFetch(`${BASE}/health`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, string>
    assert.ok(
      ['ok', 'error'].includes(body['db']!),
      'db should be ok or error',
    )
    assert.ok(
      ['ok', 'error'].includes(body['ssh']!),
      'ssh should be ok or error',
    )
    assert.ok(
      ['ok', 'error'].includes(body['livekit']!),
      'livekit should be ok or error',
    )
  })
})
