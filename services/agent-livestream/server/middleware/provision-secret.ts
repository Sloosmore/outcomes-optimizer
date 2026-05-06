import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export const provisionSecretMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }
  const token = authHeader.slice(7)
  const secret = process.env['PROVISION_SECRET']
  if (!secret) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const tokenBuf = Buffer.from(token)
  const secretBuf = Buffer.from(secret)
  if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
}
