import { Hono } from 'hono'
import { z } from 'zod'
import { getServices } from '../lib/services.js'
import {
  ChatSummary,
  ChatDetail,
  ApiArtifactPatchRequest,
  ApiArtifactActivateRequest,
  ApiStageModePatchRequest,
  ARTIFACT_TILES_MAX,
} from '@skill-networks/contracts/chat'
import type {
  ApiArtifactPatchResponse,
  ApiArtifactActivateResponse,
  ApiStageModePatchResponse,
  ArtifactTile,
} from '@skill-networks/contracts/chat'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:chats')
const artifactPatchLogger = createLogger('agent-livestream:artifact-patch')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ChatCreateBody = z.object({ title: z.string().max(500).optional() })

const router = new Hono()

/** Promote `url` to index 0, dedupe existing entries, cap to ARTIFACT_TILES_MAX. */
function promoteUrl(current: ArtifactTile[], url: string): ArtifactTile[] {
  const filtered = current.filter((t) => t.url !== url)
  const next = [{ url }, ...filtered]
  return next.slice(0, ARTIFACT_TILES_MAX)
}

router.get('/', async (c) => {
  const { chats } = getServices()
  try {
    const data = await chats.findRecent(100)
    const valid: Array<{ id: string; title: string; createdAt: string }> = []
    for (const r of data) {
      const row = { id: r.id, title: r.title, createdAt: r.created_at }
      const result = ChatSummary.safeParse(row)
      if (result.success) valid.push(result.data)
    }
    return c.json(valid)
  } catch (e) {
    logger.error('chats GET error', { error: e instanceof Error ? e.message : String(e) })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

router.post('/', async (c) => {
  const bodyParsed = ChatCreateBody.safeParse(await c.req.json())
  if (!bodyParsed.success) return c.json({ error: bodyParsed.error.message }, 400)
  const title = bodyParsed.data.title ?? 'New call'
  const { chats } = getServices()
  try {
    const data = await chats.create(title)
    const row = { id: data.id, title: data.title, createdAt: data.created_at }
    const valid = ChatSummary.parse(row)
    return c.json(valid, 201)
  } catch (e) {
    logger.error('chats POST error', { error: e instanceof Error ? e.message : String(e) })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

router.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Invalid id' }, 400)
  const { chats } = getServices()
  try {
    const data = await chats.findById(id)
    if (!data) return c.json({ error: 'Not found' }, 404)
    const row = {
      id: data.id,
      title: data.title,
      createdAt: data.created_at,
      artifactTiles: data.artifact_tiles ?? [],
      stageMode: data.stage_mode ?? false,
    }
    const valid = ChatDetail.parse(row)
    return c.json(valid)
  } catch (e) {
    logger.error('chats GET by id error', { error: e instanceof Error ? e.message : String(e) })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

router.patch('/:id/artifact', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    artifactPatchLogger.warn('artifact PATCH invalid id', { id })
    return c.json({ error: 'Invalid id' }, 400)
  }
  let rawBody: unknown
  try { rawBody = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const parsed = ApiArtifactPatchRequest.safeParse(rawBody)
  artifactPatchLogger.info('phase', {
    phase: 'artifact_patch_request',
    chatId: id,
    t_ms: performance.now(),
  })
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  // Legacy emitters (port-only payloads) send `{ port: N }` with no url.
  // Treat as a no-op rather than crashing — the port field is accepted but
  // ignored; the rail is only updated when a URL is present.
  if (!parsed.data.url) return c.json({ ok: true } satisfies ApiArtifactPatchResponse)
  const url = parsed.data.url
  const { chats } = getServices()
  try {
    const current = await chats.findById(id)
    if (!current) return c.json({ error: 'Not found' }, 404)
    const next = promoteUrl(current.artifact_tiles ?? [], url)
    await chats.updateArtifactTiles(id, next)
    artifactPatchLogger.info('artifact PATCH applied', {
      chatId: id,
      urlPreview: url.slice(0, 120),
      tilesCount: next.length,
    })
    artifactPatchLogger.info('phase', {
      phase: 'artifact_patch_response',
      chatId: id,
      t_ms: performance.now(),
      status: 200,
    })
    return c.json({ ok: true } satisfies ApiArtifactPatchResponse)
  } catch (e) {
    artifactPatchLogger.error('chats artifact PATCH error', {
      chatId: id,
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

router.post('/:id/artifact/activate', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Invalid id' }, 400)
  let rawBody: unknown
  try { rawBody = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const parsed = ApiArtifactActivateRequest.safeParse(rawBody)
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  const { chats } = getServices()
  try {
    const current = await chats.findById(id)
    if (!current) return c.json({ error: 'Not found' }, 404)
    const tiles = current.artifact_tiles ?? []
    if (!tiles.some((t) => t.url === parsed.data.url)) {
      return c.json({ error: 'URL not on rail; PATCH first' }, 400)
    }
    const next = promoteUrl(tiles, parsed.data.url)
    await chats.updateArtifactTiles(id, next)
    return c.json({ ok: true } satisfies ApiArtifactActivateResponse)
  } catch (e) {
    logger.error('chats artifact ACTIVATE error', {
      chatId: id,
      error: e instanceof Error ? e.message : String(e),
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

router.patch('/:id/stage-mode', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Invalid id' }, 400)
  let rawBody: unknown
  try { rawBody = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const parsed = ApiStageModePatchRequest.safeParse(rawBody)
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  const { chats } = getServices()
  try {
    const current = await chats.findById(id)
    if (!current) return c.json({ error: 'Not found' }, 404)
    await chats.updateStageMode(id, parsed.data.enabled)
    return c.json({ ok: true } satisfies ApiStageModePatchResponse)
  } catch (e) {
    logger.error('chats stage-mode PATCH error', {
      chatId: id,
      error: e instanceof Error ? e.message : String(e),
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export { router as chatsRouter }
