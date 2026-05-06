import type { voice, JobContext } from '../adapters/realtime/livekit-agents.js'
import { createLogger } from '@skill-networks/logger'
import { queueToolReply } from '../lib/queued-reply.js'

const logger = createLogger('agent-livestream:dispatch-tool')

interface DispatchToolOptions {
  specUrl: string
  session: voice.AgentSession
  ctx: JobContext
  /** voice-tool JWT — auths against /api/voice-tool/dispatch which extracts user_id. */
  voiceToolJwt?: string
  /** BFF base URL (Vercel BFF in prod, localhost:3001 in dev). */
  bffUrl: string
  /** chat id — used to PATCH the artifact URL onto the chats row so the iframe survives a reload. */
  chatId?: string
  /** internal secret for the chats artifact PATCH bypass. */
  internalSecret?: string
  /** Optional global view-mode toggle. Same semantics as share_screen:
   *   - `focus`     → stageMode=false (single full-bleed)
   *   - `spotlight` → stageMode=true  (multi-tile Stage Manager view)
   *  Omitted → preserve current view mode. */
  mode?: 'focus' | 'spotlight'
}

/**
 * Demo dispatch: posts to /api/voice-tool/dispatch which returns the dashboard
 * URL of the user's most recent process. Emits the URL via the same
 * `artifact_ready` data channel topic share_screen uses. Frontend already
 * renders that topic via ArtifactIframe; the URL is same-origin so the iframe
 * inherits the user's Supabase session and the dashboard auto-authenticates.
 *
 * No URL validation here because the URL is server-constructed (relative path
 * starting with `/p/`) — not LLM input.
 */
export async function executeDispatchTool({
  specUrl,
  session,
  ctx,
  voiceToolJwt,
  bffUrl,
  chatId,
  internalSecret,
  mode,
}: DispatchToolOptions): Promise<void> {
  if (!voiceToolJwt) {
    logger.warn('dispatch: missing voiceToolJwt — cannot auth against BFF')
    void queueToolReply(session, 'dispatch', "I can't dispatch right now — voice auth isn't configured.")
    return
  }

  let url: string
  try {
    const res = await fetch(`${bffUrl}/api/voice-tool/dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${voiceToolJwt}`,
      },
      body: JSON.stringify({ spec_url: specUrl }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      logger.warn('dispatch: BFF returned non-OK', { status: res.status, errBody: errBody.slice(0, 200) })
      void queueToolReply(session, 'dispatch', "I couldn't find a recent task to display.")
      return
    }
    const json = await res.json() as { url?: string; processName?: string }
    if (!json.url) {
      logger.warn('dispatch: BFF response missing url', { json })
      void queueToolReply(session, 'dispatch', "Dispatch is set up but I couldn't get a URL back.")
      return
    }
    url = json.url
    logger.info('dispatch: got url', { processName: json.processName })
  } catch (err) {
    logger.error('dispatch: BFF call failed', { error: err instanceof Error ? err.message : String(err) })
    void queueToolReply(session, 'dispatch', "I hit an error contacting the dispatch service.")
    return
  }

  // If a view mode was specified, flip the global stageMode boolean before
  // emitting artifact_ready so the frontend re-render (single vs rail) lands
  // together with the new URL. Same semantics as share_screen.
  if (mode && chatId && internalSecret) {
    try {
      const enabled = mode === 'spotlight'
      const res = await fetch(`${bffUrl}/api/chats/${chatId}/stage-mode`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Research-Secret': internalSecret,
        },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) {
        logger.warn('dispatch: PATCH stage-mode non-OK', { status: res.status, chatId, mode })
      }
    } catch (err) {
      logger.warn('dispatch: PATCH stage-mode failed', {
        error: err instanceof Error ? err.message : String(err),
        chatId,
        mode,
      })
    }
  }

  // Emit on same artifact_ready topic share_screen uses.
  if (ctx.agent) {
    await ctx.agent.sendText(
      JSON.stringify({ url, port: 0, summary: '' }),
      { topic: 'artifact_ready' },
    )
  }

  // Persist the URL onto the chats row so the iframe survives a page reload.
  // Best-effort, same pattern as share_screen.
  if (chatId && internalSecret) {
    try {
      const patchRes = await fetch(`${bffUrl}/api/chats/${chatId}/artifact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Research-Secret': internalSecret,
        },
        body: JSON.stringify({ url }),
      })
      if (!patchRes.ok) {
        logger.warn('dispatch: PATCH artifact url non-OK', { status: patchRes.status, chatId })
      }
    } catch (err) {
      logger.warn('dispatch: PATCH artifact url failed', {
        error: err instanceof Error ? err.message : String(err),
        chatId,
      })
    }
  }

  // Don't generateReply — the LLM already received the tool output text and
  // will speak naturally. Same logic share-screen-tool documents.
}
