import { Hono } from 'hono'
import type { JWTPayload } from 'jose'
import { createLogger } from '@skill-networks/logger'
import { ProjectScopeService } from '@skill-networks/database/services'
import { ApiResourcesResponse, ApiResourceLinksResponse, ApiResourceTypesResponse } from '@skill-networks/contracts/graph'
import { getServices } from '../lib/services.js'

const logger = createLogger('agent-livestream')

type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}

export const resourcesRouter = new Hono<Env>()

resourcesRouter.get('/resources', async (c) => {
  const { resources } = getServices()
  try {
    const payload = c.get('jwtPayload') as JWTPayload
    const callerUserId = payload.sub ?? ''
    const authorized = await resources.resolveUserProjects(callerUserId)
    const scopeService = new ProjectScopeService(getServices().sql)
    const scope = await scopeService.resolve({ roots: [...authorized] })
    const data = await resources.list()
    const coerced = data.map((row) => ({
      ...row,
      config: typeof row.config === 'string'
        ? (() => { try { return JSON.parse(row.config) } catch { return null } })()
        : row.config,
    }))
    const filtered = scope.filterResources(coerced as unknown as Array<{ id: string } & Record<string, unknown>>)
    const valid = ApiResourcesResponse.parse(filtered)
    return c.json(valid)
  } catch (e) {
    logger.error('Request failed', { endpoint: '/api/resources', error: e })
    return c.json({ error: 'Response validation failed' }, 500)
  }
})

resourcesRouter.get('/resource-links', async (c) => {
  const { resources } = getServices()
  try {
    const payload = c.get('jwtPayload') as JWTPayload
    const callerUserId = payload.sub ?? ''
    const authorized = await resources.resolveUserProjects(callerUserId)
    const scopeService = new ProjectScopeService(getServices().sql)
    const scope = await scopeService.resolve({ roots: [...authorized] })
    const data = await resources.listAllLinks()
    const rows = data.map(row => ({
      id: `${row.from_id}__${row.to_id}`,
      ...row,
    }))
    const filtered = scope.filterLinks(rows)
    const valid = ApiResourceLinksResponse.parse(filtered)
    return c.json(valid)
  } catch (e) {
    logger.error('Request failed', { endpoint: '/api/resource-links', error: e })
    return c.json({ error: 'Response validation failed' }, 500)
  }
})

resourcesRouter.get('/resource-types', async (c) => {
  // Intentionally unscoped — resource type names are generic metadata (e.g. "user", "project", "skill")
  // and are not project-sensitive. All authenticated users may see the full type registry.
  const { resources } = getServices()
  try {
    const types = await resources.listDistinctTypes()
    return c.json(types as ApiResourceTypesResponse)
  } catch (e) {
    logger.error('DB query failed', { endpoint: '/api/resource-types', error: e })
    return c.json({ error: 'Internal server error' }, 500)
  }
})
