import { Hono } from 'hono'
import { z } from 'zod'
import { getServices } from '../lib/services.js'
import { MessageRow } from '@skill-networks/contracts/chat'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:messages')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MessageBody = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(100_000),
})

const router = new Hono()

router.get('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Invalid id' }, 400)
  const { messages } = getServices()
  try {
    const data = await messages.findByChatId(id, 500)
    const rows = data.map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }))
    try {
      const valid = MessageRow.array().parse(rows)
      return c.json(valid)
    } catch (e) {
      logger.error('messages GET Zod parse failed', { error: e instanceof Error ? e.message : String(e) })
      return c.json([], 500)
    }
  } catch (e) {
    logger.error('messages GET DB error', { error: e instanceof Error ? e.message : String(e) })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Validate incoming message shape but reject — persistence is handled by voice-agent.ts.
// The route exists to return a structured 400 on bad input rather than a generic 404.
router.post('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Invalid id' }, 400)
  const parsed = MessageBody.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  // Persistence is handled exclusively by the voice-agent ConversationItemAdded handler.
  // Direct HTTP writes are not supported.
  return c.json({ error: 'Method not allowed' }, 405, { Allow: 'GET' })
})

export { router as messagesRouter }
