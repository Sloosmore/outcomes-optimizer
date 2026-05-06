import type { voice, JobContext } from '../adapters/realtime/livekit-agents.js'
import { createLogger } from '@skill-networks/logger'
import { queueToolReply } from '../lib/queued-reply.js'

const logger = createLogger('agent-livestream:share-screen-tool')

interface ShareScreenToolOptions {
  /** Optional. Omit to flip view mode only — the current artifact stays. */
  url?: string
  session: voice.AgentSession
  ctx: JobContext
  /** Chat id — used to PATCH the artifact URL onto the chats row so the iframe survives a reload. */
  chatId?: string
  /** BFF base URL for the PATCH. Same convention as voice-agent.ts BFF_URL. */
  bffUrl?: string
  /** Internal secret to bypass the JWT wall when PATCHing from the agent. */
  internalSecret?: string
  /** Optional global view-mode toggle. When provided, also flips the chat's
   *  `stageMode` boolean before sharing the URL:
   *   - `focus`     → stageMode=false (single full-bleed iframe, no rail)
   *   - `spotlight` → stageMode=true  (multi-tile Stage Manager view)
   *  When omitted, the current view mode is preserved. The new URL is always
   *  promoted to the active tile regardless of mode. */
  mode?: 'focus' | 'spotlight'
}

export async function executeShareScreenTool({
  url,
  session,
  ctx,
  chatId,
  bffUrl,
  internalSecret,
  mode,
}: ShareScreenToolOptions): Promise<void> {
  const safeUrlLog = (() => { try { const p = url ? new URL(url) : null; return p ? { origin: p.origin, pathname: p.pathname } : { mode } } catch { return {} } })()
  logger.info('share_screen tool called', safeUrlLog)

  // Either url or mode must be present — calling with neither is a no-op.
  if (!url && !mode) {
    logger.warn('share_screen: called with neither url nor mode')
    void queueToolReply(session, 'share_screen', "I need either a URL to display or a view mode to switch to.")
    return
  }

  // Validate URL only when one is provided.
  if (url) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      logger.warn('share_screen: invalid URL', safeUrlLog)
      void queueToolReply(session, 'share_screen', 'I am unable to display that URL — it appears to be invalid.')
      return
    }
    if (parsed.protocol !== 'https:') {
      logger.warn('share_screen: non-https URL rejected', safeUrlLog)
      void queueToolReply(session, 'share_screen', 'I can only display secure https URLs.')
      return
    }
  }

  // If the caller specified a view mode, flip the global stageMode toggle on
  // the chat row BEFORE emitting artifact_ready so the frontend re-render
  // (single-tile vs Stage Manager rail) lands together with the new URL.
  if (mode && chatId && bffUrl && internalSecret) {
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
        logger.warn('share_screen: PATCH stage-mode non-OK', { status: res.status, chatId, mode })
      }
    } catch (err) {
      logger.warn('share_screen: PATCH stage-mode failed', {
        error: err instanceof Error ? err.message : String(err),
        chatId,
        mode,
      })
    }
  }

  if (url && ctx.agent) {
    // port: 0 is the contract sentinel for "no port, URL-only mode".
    // nonce makes each message unique so the frontend dedup (processedRef)
    // does not suppress repeated calls to the same URL (e.g. hop-back).
    // stageMode (when the caller passed `mode`) lets the FE flip the renderer
    // optimistically on the next paint instead of waiting for the chat-detail
    // refetch — same pattern as the optimistic tile write in useStageTiles.
    const payload: Record<string, unknown> = { url, port: 0, summary: '', nonce: Date.now() }
    if (mode) payload['stageMode'] = mode
    await ctx.agent.sendText(JSON.stringify(payload), { topic: 'artifact_ready' })
  } else if (mode && ctx.agent) {
    // No URL change — just a renderer flip. Emit the bare stageMode signal
    // so the FE handler can still apply it optimistically. The handler
    // ignores entries without a URL except for picking up stageMode.
    await ctx.agent.sendText(
      JSON.stringify({ stageMode: mode, port: 0, summary: '', nonce: Date.now() }),
      { topic: 'artifact_ready' },
    )
  }

  // Persist the URL onto the chats row so the iframe survives a page reload.
  // Best-effort: a failure here doesn't break the live share via the data
  // channel above, only the post-reload restoration. We use the same internal
  // secret the agent uses for history fetches to bypass the BFF's JWT wall.
  if (url && chatId && bffUrl && internalSecret) {
    try {
      const res = await fetch(`${bffUrl}/api/chats/${chatId}/artifact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Research-Secret': internalSecret,
        },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        logger.warn('share_screen: PATCH artifact url non-OK', { status: res.status, chatId })
      }
    } catch (err) {
      logger.warn('share_screen: PATCH artifact url failed', {
        error: err instanceof Error ? err.message : String(err),
        chatId,
      })
    }
  } else if (url) {
    // Live share works fine without persistence, but a page reload won't restore
    // the iframe. Surface the misconfiguration so it shows up in agent logs the
    // same way the missing-history-fetch secret does.
    logger.warn('share_screen: skipping PATCH (artifact_url will not persist)', {
      hasChatId: !!chatId,
      hasBffUrl: !!bffUrl,
      hasInternalSecret: !!internalSecret,
    })
  }

  // Do NOT call session.generateReply here — the LLM already received the tool
  // output ('Sharing screen now.') and will generate speech naturally. A second
  // generateReply would race with the next text injection and corrupt the pipeline.
}
