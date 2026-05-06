import { Hono } from 'hono'
import { z } from 'zod'
import type { JWTPayload } from 'jose'
import { createLogger } from '@skill-networks/logger'
import { ProjectScopeService } from '@skill-networks/database/services'
import { getServices } from '../lib/services.js'
import { buildGraph } from '../graph.js'

const logger = createLogger('agent-livestream')

const typesQuerySchema = z.array(z.string().max(100)).max(20).default([])

type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}

export const graphRouter = new Hono<Env>()

graphRouter.get('/', async (c) => {
  const typesResult = typesQuerySchema.safeParse(c.req.queries('types') ?? [])
  if (!typesResult.success) return c.json({ error: 'Invalid types parameter' }, 400)
  const rawProjectId = c.req.query('projectId')
  if (rawProjectId !== undefined && !z.string().uuid().safeParse(rawProjectId).success) {
    return c.json({ error: 'Invalid projectId — must be a UUID' }, 400)
  }
  try {
    const services = getServices()
    const payload = c.get('jwtPayload') as JWTPayload
    const callerUserId = payload.sub ?? ''
    const authorized = await services.resources.resolveUserProjects(callerUserId)
    if (rawProjectId !== undefined && !authorized.has(rawProjectId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const scopeService = new ProjectScopeService(services.sql)
    const scope = await scopeService.resolve({ roots: rawProjectId ? [rawProjectId] : [...authorized] })
    const graph = await buildGraph(services, typesResult.data, { scope, projectId: rawProjectId })
    return c.json(graph)
  } catch (error) {
    logger.error('DB query failed', { endpoint: '/api/graph', error })
    return c.json({ error: 'Internal server error' }, 500)
  }
})
