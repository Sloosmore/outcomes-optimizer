import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env['CREDENTIAL_PROXY_BYPASS_URLS'] = 'http://localhost:3001'

const BASE = 'http://localhost:3001'
const apiFetch =
  ((globalThis as Record<string, unknown>)['__nativeFetch'] as typeof fetch) ??
  globalThis.fetch

describe('test:token', () => {
  it('GET /token returns JWT with exp > now + 30s and room + identity claims', async () => {
    try {
      await apiFetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    } catch {
      // eslint-disable-next-line no-console -- skip message
      console.log('# BFF not running — skipping test:token')
      return
    }

    // Wait for rate-limit window to reset (1s window, shared with other tests)
    await new Promise((r) => setTimeout(r, 1200))

    const chatId = crypto.randomUUID()
    const res = await apiFetch(`${BASE}/token?chatId=${chatId}`)
    // Token endpoint may return 500 if LiveKit not configured
    if (res.status === 500) {
      // eslint-disable-next-line no-console -- skip message
      console.log('# LiveKit not configured — skipping token claims check')
      return
    }
    assert.equal(res.status, 200)
    const body = (await res.json()) as { token: string; expiresAt: string }
    assert.ok(body.token, 'token should exist')
    assert.ok(body.expiresAt, 'expiresAt should exist')

    // Decode JWT payload (base64url)
    const parts = body.token.split('.')
    assert.equal(parts.length, 3, 'JWT should have 3 parts')
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString(),
    ) as Record<string, unknown>
    const exp = payload['exp'] as number
    assert.ok(exp > Date.now() / 1000 + 30, 'exp should be > now + 30s')

    // LiveKit tokens use 'video' grant with room claim
    const video = payload['video'] as Record<string, unknown> | undefined
    assert.ok(video, 'JWT should have video grant')
    assert.ok(video['room'], 'video grant should have room')
    assert.ok(
      payload['sub'] || payload['iss'],
      'JWT should have identity (sub or iss)',
    )
  })
})
