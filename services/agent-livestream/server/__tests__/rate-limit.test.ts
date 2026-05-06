import { Hono } from 'hono'
import { createRateLimiter } from '../middleware/rate-limit.js'
import { describe, it, expect } from 'vitest'

describe('rate limiter middleware', () => {
  it('blocks after max requests are exceeded', async () => {
    const app = new Hono()
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 })
    app.post('/test', limiter, (c) => c.json({ ok: true }))

    const makeReq = () =>
      app.request('/test', {
        method: 'POST',
        headers: { 'x-forwarded-for': '127.0.0.1' },
      })

    // First 3 requests should succeed
    for (let i = 0; i < 3; i++) {
      const res = await makeReq()
      expect(res.status).toBe(200)
    }

    // 4th request should be rate-limited
    const blocked = await makeReq()
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'Too many requests' })
  })

  it('uses the first IP from x-forwarded-for when multiple are present', async () => {
    const app = new Hono()
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 })
    app.post('/test', limiter, (c) => c.json({ ok: true }))

    const makeReq = (ip: string) =>
      app.request('/test', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
      })

    // Requests from "1.1.1.1, proxy1, proxy2" should be bucketed as "1.1.1.1"
    await makeReq('1.1.1.1, proxy1, proxy2')
    await makeReq('1.1.1.1, proxy1, proxy2')
    const blocked = await makeReq('1.1.1.1, proxy1, proxy2')
    expect(blocked.status).toBe(429)

    // Requests from a different first IP should have their own bucket
    const diffIp = await makeReq('2.2.2.2, proxy1')
    expect(diffIp.status).toBe(200)
  })

  it('falls back to unknown when x-forwarded-for is absent', async () => {
    const app = new Hono()
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 })
    app.post('/test', limiter, (c) => c.json({ ok: true }))

    const makeReq = () => app.request('/test', { method: 'POST' })

    const first = await makeReq()
    expect(first.status).toBe(200)
    const second = await makeReq()
    expect(second.status).toBe(429)
  })
})
