import type { MiddlewareHandler } from 'hono'

interface RateLimitEntry {
  count: number
  resetAt: number
}

const MAX_STORE_SIZE = 10_000

export function createRateLimiter(opts: {
  max: number
  windowMs: number
}): MiddlewareHandler {
  const store = new Map<string, RateLimitEntry>()

  return async (c, next) => {
    const now = Date.now()
    // Prefer x-forwarded-for (first hop = original client) → x-real-ip → fall
    // back to a single shared bucket. The 'unknown' bucket is intentional but
    // caps risk: if many anonymous callers share one bucket, the worst case
    // is they collectively share the rate limit (DoS-safe), not that an
    // attacker can exhaust other users' quotas (those buckets are keyed by IP).
    const forwarded = c.req.header('x-forwarded-for')
    const realIp = c.req.header('x-real-ip')
    const ip = forwarded
      ? forwarded.split(',')[0].trim()
      : realIp?.trim() || 'unknown'

    // Clean up expired entries
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key)
    }

    // Guard against unbounded growth under IP-spoofing attacks
    if (store.size >= MAX_STORE_SIZE) {
      return c.json({ error: 'Too many requests' }, 429)
    }

    const entry = store.get(ip)
    if (entry && entry.resetAt > now) {
      if (entry.count >= opts.max) {
        return c.json({ error: 'Too many requests' }, 429)
      }
      entry.count++
    } else {
      store.set(ip, { count: 1, resetAt: now + opts.windowMs })
    }

    await next()
  }
}
