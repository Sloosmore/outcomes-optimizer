import { Hono } from 'hono'
import { z } from 'zod'
import type { JWTPayload } from 'jose'
import { createLogger } from '@skill-networks/logger'
import { ApiMetricsLatestResponseSchema } from '@skill-networks/contracts/metrics'
import { getServices } from '../lib/services.js'
import { fetchLatestMetrics } from '../metrics.js'

const logger = createLogger('agent-livestream')

type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}

export const metricsRouter = new Hono<Env>()

metricsRouter.get('/latest', async (c) => {
  const rawSkillId = c.req.query('skill_id')
  if (rawSkillId !== undefined && !z.string().uuid().safeParse(rawSkillId).success) {
    return c.json({ error: 'Invalid skill_id — must be a UUID' }, 400)
  }
  const rawProjectId = c.req.query('projectId')
  if (rawProjectId !== undefined && !z.string().uuid().safeParse(rawProjectId).success) {
    return c.json({ error: 'Invalid projectId — must be a UUID' }, 400)
  }
  try {
    const { metrics, resources } = getServices()
    const payload = c.get('jwtPayload') as JWTPayload
    const callerUserId = payload.sub ?? ''
    const authorized = await resources.resolveUserProjects(callerUserId)
    if (rawProjectId !== undefined && !authorized.has(rawProjectId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const data = await fetchLatestMetrics(metrics, rawSkillId ?? '', rawProjectId, resources)
    const result = ApiMetricsLatestResponseSchema.safeParse(data)
    if (!result.success) {
      logger.error('Zod parse failed', { endpoint: '/api/metrics/latest', error: result.error })
      return c.json({ error: 'Metrics data validation failed' }, 500)
    }
    return c.json(result.data)
  } catch (error) {
    logger.error('DB query failed', { endpoint: '/api/metrics/latest', error })
    return c.json({ error: 'Internal server error' }, 500)
  }
})
