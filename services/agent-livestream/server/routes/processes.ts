import { Hono } from 'hono'
import { z } from 'zod'
import type { JWTPayload } from 'jose'
import { createLogger } from '@skill-networks/logger'
import { ProcessEventSchema } from '@skill-networks/contracts/processes'
import type { EpochResult } from '@skill-networks/contracts/epochs'
import type { EpochRow } from '@skill-networks/database/services'
import { getServices } from '../lib/services.js'
import { queryProcesses } from '../processes.js'

const logger = createLogger('agent-livestream')

const processStatusSchema = z.enum(['pending', 'active', 'paused', 'waiting', 'completed', 'failed'])

type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}

export const processesRouter = new Hono<Env>()

processesRouter.get('/processes', async (c) => {
  const rawStatus = c.req.query('status')
  let statusFilter: string | string[] | undefined
  if (rawStatus) {
    const results = rawStatus.split(',').map((s) => processStatusSchema.safeParse(s.trim()))
    if (results.some((r) => !r.success)) return c.json({ error: 'Invalid status value' }, 400)
    const statuses = results.map((r) => r.data!)
    statusFilter = statuses.length === 1 ? statuses[0] : statuses
  }
  const rawProject = c.req.query('project')
  const rawSince = c.req.query('since')
  if (rawSince && !z.string().datetime().safeParse(rawSince).success) {
    return c.json({ error: 'Invalid since: must be an ISO 8601 datetime' }, 400)
  }
  try {
    const { processes, resources } = getServices()
    const payload = c.get('jwtPayload') as JWTPayload
    const callerUserId = payload.sub ?? ''
    const authorized = await resources.resolveUserProjects(callerUserId)
    const rows = await queryProcesses(processes, resources, statusFilter, rawSince, rawProject)
    // Processes with null project_id are legacy (pre-scoping) and excluded from scoped results.
    // When ENFORCE_PROJECT_SCOPING is enabled, this will be enforced globally.
    const filtered = rows.filter((r) => r.project_id != null && authorized.has(r.project_id))
    return c.json(filtered)
  } catch (error) {
    logger.error('DB query failed', { endpoint: '/api/processes', error })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

const tsSchema = z.string().datetime()

processesRouter.get('/process-events/:processId', async (c) => {
  const processId = c.req.param('processId')
  if (!z.string().uuid().safeParse(processId).success) return c.json({ error: 'Invalid processId' }, 400)

  const limitParam = c.req.query('limit')
  const before = c.req.query('before')
  const after = c.req.query('after')
  const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 200)

  if (before && !tsSchema.safeParse(before).success) return c.json({ error: 'Invalid before cursor' }, 400)
  if (after && !tsSchema.safeParse(after).success) return c.json({ error: 'Invalid after cursor' }, 400)

  const { processes, events, resources } = getServices()

  const payload = c.get('jwtPayload') as JWTPayload
  const callerUserId = payload.sub ?? ''
  const authorized = await resources.resolveUserProjects(callerUserId)

  // Resolve the full process chain via root_process_id so restarted processes show all events
  let rootId = processId
  try {
    const proc = await processes.getById(processId)
    if (proc && proc.project_id !== null && !authorized.has(proc.project_id)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (proc) rootId = proc.root_process_id ?? processId
  } catch (err) {
    logger.warn('Failed to resolve root_process_id', { processId, error: err })
  }

  let processIds: string[]
  try {
    const chain = await processes.resolveChain(rootId)
    const chainIds = chain.map((p) => p.id)
    // Always include the requested processId — chain may be empty if the process is its own root
    processIds = chainIds.length > 0 ? chainIds : [processId]
  } catch (err) {
    logger.warn('Failed to resolve process chain', { rootId, error: err })
    processIds = [processId]
  }

  try {
    const [eventsData, total] = await Promise.all([
      events.getByProcessIds(processIds, { before, after, limit }),
      (!before && !after) ? events.countByProcessIds(processIds) : Promise.resolve(null),
    ])

    // EventsService returns camelCase; ProcessEventSchema expects snake_case wire format
    const normalized = eventsData.map((e) => ({
      id: e.id,
      process_id: e.processId,
      resource_id: e.resourceId,
      source: e.source,
      payload: e.payload,
      ts: e.ts,
    }))
    const result = z.array(ProcessEventSchema).safeParse(normalized)
    if (!result.success) {
      logger.error('Zod parse failed', { endpoint: '/api/process-events', error: result.error })
      return c.json({ error: 'Event data validation failed' }, 500)
    }

    return c.json({ events: result.data, total: total ?? result.data.length })
  } catch (error) {
    logger.error('DB query failed', { endpoint: '/api/process-events', error })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

function toEpochResult(row: EpochRow): EpochResult {
  return {
    id: row.id,
    process_id: row.campaign_id,
    epoch_number: row.epoch_number,
    status: row.status,
    cost: row.cost,
    duration_ms: row.duration_ms,
    session_id: row.session_id,
    workflow_run_id: row.workflow_run_id,
    state_snapshot: row.state_snapshot,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
  }
}

// IMPORTANT: literal /latest route must be registered BEFORE parameterized routes
processesRouter.get('/processes/:id/epochs/latest', async (c) => {
  const id = c.req.param('id')
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid processId' }, 400)
  const { epochResults, processes, resources } = getServices()
  const payload = c.get('jwtPayload') as JWTPayload
  const callerUserId = payload.sub ?? ''
  const authorized = await resources.resolveUserProjects(callerUserId)
  try {
    const proc = await processes.getById(id)
    if (proc && proc.project_id !== null && !authorized.has(proc.project_id)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const row = await epochResults.getLatest(id)
    if (row === null) return c.json(null)
    return c.json(toEpochResult(row))
  } catch (error) {
    logger.error('DB query failed', { endpoint: '/api/processes/:id/epochs/latest', error })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

processesRouter.get('/processes/:id/epochs', async (c) => {
  const id = c.req.param('id')
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid processId' }, 400)
  const limitParam = c.req.query('limit')
  const limit = limitParam !== undefined ? Math.min(parseInt(limitParam, 10) || 100, 500) : 100
  const { epochResults, processes, resources } = getServices()
  const payload = c.get('jwtPayload') as JWTPayload
  const callerUserId = payload.sub ?? ''
  const authorized = await resources.resolveUserProjects(callerUserId)
  try {
    const proc = await processes.getById(id)
    if (proc && proc.project_id !== null && !authorized.has(proc.project_id)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const rows = await epochResults.getByProcessId(id, limit)
    return c.json(rows.map(toEpochResult))
  } catch (error) {
    logger.error('DB query failed', { endpoint: '/api/processes/:id/epochs', error })
    return c.json({ error: 'Internal server error' }, 500)
  }
})
