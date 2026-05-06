import { Hono } from 'hono'
import { AccessToken } from '../adapters/realtime/livekit-adapter.js'
import type { RealtimeRoomAdapter } from '../adapters/realtime/types.js'
import { LiveKitRealtimeRoomAdapter } from '../adapters/realtime/livekit-adapter.js'
import { MAX_AGENTS_PER_ROOM } from '../constants.js'
import { mintVoiceToolJwt } from '../lib/voice-tool-jwt.js'
import { verifyBearerToken } from '../middleware/jwt.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const tokenRateLimit = new Map<string, { count: number; resetAt: number }>()
// Prune expired entries every minute to prevent unbounded growth
setInterval(() => {
  const now = Date.now()
  for (const [key, val] of tokenRateLimit) {
    if (val.resetAt <= now) tokenRateLimit.delete(key)
  }
}, 60_000)

/**
 * Dispatches the voice agent to a room only if the room has fewer agents than MAX_AGENTS_PER_ROOM.
 * Returns { dispatched: true } on success, or { dispatched: false, reason: 'AGENT_LIMIT_EXCEEDED' }
 * when the room already has the maximum number of agents.
 * Exported for unit testing.
 */
export async function dispatchAgentIfAllowed(
  adapter: RealtimeRoomAdapter,
  roomId: string,
  agentId: string,
): Promise<{ dispatched: boolean; reason?: string }> {
  const agentCount = await adapter.getAgentCount(roomId)
  if (agentCount >= MAX_AGENTS_PER_ROOM) {
    return { dispatched: false, reason: 'AGENT_LIMIT_EXCEEDED' }
  }
  await adapter.dispatchAgent(roomId, agentId)
  return { dispatched: true }
}

const router = new Hono()

router.get('/', async (c) => {
  const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown'
  const now = Date.now()
  const window = tokenRateLimit.get(ip)
  if (window && window.resetAt > now) {
    if (window.count >= 20) {
      return c.json({ error: 'Too Many Requests' }, 429)
    }
    window.count++
  } else {
    tokenRateLimit.set(ip, { count: 1, resetAt: now + 60_000 })
  }

  const chatId = c.req.query('chatId')
  if (chatId !== undefined && !UUID_RE.test(chatId)) {
    return c.json({ error: 'Invalid chatId' }, 400)
  }
  // Active project the user was viewing in the top bar at chat-join time.
  // Forwarded into the voice-tool JWT so the dispatch tool can place the new
  // skill into that project instead of the per-user fallback. Validated
  // server-side at /api/voice-tool/dispatch — this route just embeds the
  // string so we can keep the token endpoint side-effect-free.
  const activeProjectRaw = c.req.query('activeProject')
  const activeProject = typeof activeProjectRaw === 'string'
    && activeProjectRaw.length > 0
    && activeProjectRaw.length <= 200
    && /^[a-zA-Z0-9_:.\-]+$/.test(activeProjectRaw)
    ? activeProjectRaw
    : undefined
  const apiKey = process.env['LIVEKIT_API_KEY']
  const apiSecret = process.env['LIVEKIT_API_SECRET']
  if (!apiKey || !apiSecret) return c.json({ error: 'LiveKit not configured' }, 500)

  const roomName = chatId ? `room-${chatId}` : `room-${crypto.randomUUID()}`
  const identity = `user-${crypto.randomUUID()}`
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()

  const at = new AccessToken(apiKey, apiSecret, { identity, ttl: '1h' })
  // roomCreate: true allows the first participant to create the room if it doesn't exist yet.
  // Without this, the browser cannot join a room that wasn't explicitly pre-created via the
  // RoomServiceClient (which only runs when voiceToolJwt is present in the auth header).
  at.addGrant({ roomCreate: true, roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })
  const token = await at.toJwt()

  // Best-effort voice-tool JWT minting — only issued when the caller presents a verified Supabase JWT.
  // This route is unauthenticated (/token, before the JWT wall), so we must verify the token
  // ourselves to prevent forged JWTs from obtaining a voice-tool JWT for an arbitrary user.
  let voiceToolJwt: string | undefined
  const authHeader = c.req.header('Authorization')
  const voiceSecret = process.env['VOICE_TOOL_JWT_SECRET']
  if (authHeader?.startsWith('Bearer ') && voiceSecret) {
    try {
      const rawToken = authHeader.slice(7)
      const verified = await verifyBearerToken(rawToken)
      const sub = typeof verified?.sub === 'string' ? verified.sub : undefined
      if (sub) {
        voiceToolJwt = await mintVoiceToolJwt(sub, roomName, voiceSecret, activeProject)
      }
    } catch {
      // Best-effort: if verification or minting fails, omit voiceToolJwt from response
    }
  }

  if (voiceToolJwt) {
    const livekitUrl = process.env['LIVEKIT_URL'] ?? ''
    if (livekitUrl && apiKey && apiSecret) {
      const adapter = new LiveKitRealtimeRoomAdapter(livekitUrl, apiKey, apiSecret)
      const roomMetadata = JSON.stringify({ voiceToolJwt })
      // Pre-create the room so room metadata (voiceToolJwt) is set before any
      // participant joins. Then explicitly dispatch the named voice-agent —
      // LiveKit Cloud's `createRoom({ agents: [...] })` and project-side
      // auto-dispatch are both unreliable (livekit/agents-js#1211, #290);
      // explicit `AgentDispatchClient.createDispatch` is the only path with
      // reproducible community success.
      await adapter.createRoom(roomName, roomMetadata).catch(() => {/* room may already exist */})
      await dispatchAgentIfAllowed(adapter, roomName, 'voice-agent').catch(() => {/* logged elsewhere; do not fail token mint */})
    }
  }

  return c.json({ token, expiresAt, ...(voiceToolJwt ? { voiceToolJwt } : {}) })
})

export { router as tokenRouter }
