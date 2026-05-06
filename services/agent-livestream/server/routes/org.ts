import { Hono } from 'hono'
import type { JWTPayload } from 'jose'
import { getServices } from '../lib/services.js'
import { ApiOrgResponse } from '@skill-networks/contracts/org'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:org')

type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}

export const orgRouter = new Hono<Env>()

orgRouter.get('/', async (c) => {
  const jwtPayload = c.var.jwtPayload as JWTPayload
  const userId = jwtPayload.sub
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const { resources } = getServices()

  // Resolve projects the user is a member_of via direct SQL (link_type = 'member_of')
  let projectIdsSet: Set<string>
  try {
    projectIdsSet = await resources.resolveUserProjects(userId)
  } catch (e) {
    logger.error('Failed to resolve user projects', { error: e })
    return c.json({ projects: [] } satisfies ApiOrgResponse)
  }

  const projectIds = [...projectIdsSet]
  if (projectIds.length === 0) return c.json({ projects: [] } satisfies ApiOrgResponse)

  let projectResources: Array<{ id: string; name: string; config: Record<string, unknown> | null }>
  try {
    projectResources = await resources.findByTypeAndIds('project', projectIds) as typeof projectResources
  } catch (e) {
    logger.error('Failed to fetch project resources', { error: e })
    return c.json({ projects: [] } satisfies ApiOrgResponse)
  }

  const projects = projectResources.map((r) => ({
    id: r.id,
    name: r.name ?? '',
    ...(r.config && typeof r.config === 'object' && 'initials' in (r.config as object)
      ? { initials: ((r.config as Record<string, unknown>)['initials'] as string) }
      : {}),
  }))

  try {
    const valid = ApiOrgResponse.parse({ projects })
    return c.json(valid)
  } catch (e) {
    logger.error('Org response validation failed', { error: e })
    return c.json({ error: 'Response validation failed' }, 500)
  }
})
