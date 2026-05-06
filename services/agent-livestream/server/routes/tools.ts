import { Hono } from 'hono'
import { z } from 'zod'
import type { JWTPayload } from 'jose'
import { createLogger } from '@skill-networks/logger'
import { getAllToolDefs, buildTools } from '../tools.js'
import { parseArtifactTag, resolveArtifactUrl } from '../artifact-parser.js'
import { ApiToolsListResponse } from '@skill-networks/contracts/tools'

const logger = createLogger('tools-route')

const ToolNameParam = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(100)

export const toolsRouter = new Hono()

toolsRouter.get('/', (c) => {
  const defs = getAllToolDefs().map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }))
  return c.json({ tools: defs } satisfies ApiToolsListResponse)
})

toolsRouter.post('/:name', async (c) => {
  const nameResult = ToolNameParam.safeParse(c.req.param('name'))
  if (!nameResult.success) return c.json({ error: 'Invalid tool name' }, 400)

  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400)
  }

  // The JWT middleware sets jwtPayload on the context. .sub is the auth_user_id.
  // The synthetic 'internal-voice-agent' payload (used by the co-located voice
  // agent's RESEARCH_INTERNAL_SECRET bypass) has no real user — voice has its
  // own per-tool execute path and should not reach this route in the new design.
  const payload = (c as unknown as { get: (k: string) => unknown }).get('jwtPayload') as JWTPayload | undefined
  const sub = typeof payload?.sub === 'string' ? payload.sub : undefined
  if (!sub || sub === 'internal-voice-agent') {
    return c.json({ error: 'Authenticated user required for tool execution' }, 401)
  }

  const tools = buildTools({ authUserId: sub })
  const tool = tools[nameResult.data]
  if (!tool) return c.json({ error: `Unknown tool: ${nameResult.data}` }, 404)

  try {
    const result = await tool.execute(body)
    const resultObj = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
    const artifactSource = String(resultObj['text'] ?? resultObj['summary'] ?? '')
    const artifact = parseArtifactTag(artifactSource)
    if (!artifact) return c.json(result)
    const url = resolveArtifactUrl(artifact)
    const sideEffect = { event: 'ARTIFACT', port: artifact.port, label: artifact.label, url, ...(artifact.path ? { path: artifact.path } : {}) }
    return c.json({ ...resultObj, sideEffects: [sideEffect] })
  } catch (err) {
    logger.error('Tool execution failed', { tool: nameResult.data, err })
    return c.json({ error: 'Tool execution failed' }, 500)
  }
})
