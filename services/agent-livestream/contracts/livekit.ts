import { z } from 'zod'

export const ResearchDispatch = z.object({
  prompt: z.string(),
  chatId: z.string().uuid(),
})

export const ArtifactReady = z.object({
  /** Port of the artifact server. 0 means no port (data-URI artifacts). */
  port: z.number().int().min(0).max(65535),
  summary: z.string(),
  /** Full URL — when present, the iframe uses this directly instead of reconstructing from port.
   *  Accepts:
   *  - http(s)://… absolute (sandbox artifact servers, public links)
   *  - data:image/…  safe image data URIs (SVG, PNG, JPEG, GIF, WebP) for inline artifacts
   *    when no HTTP server is available (e.g. inside LiveKit cloud containers).
   *    NOTE: data:text/html is explicitly rejected — the iframe uses allow-same-origin
   *    + allow-scripts, so an HTML data URI can read cookies and make authenticated
   *    same-origin API calls (XSS).
   *  - /… root-relative paths (dispatch tool — same-origin so the iframe
   *    inherits the parent's Supabase session)
   *
   *  Rejects javascript:, vbscript:, file:, //protocol-relative, data:text/html,
   *  and any other scheme. Server-constructed URLs are still safe by construction;
   *  this refine is a defense-in-depth boundary against future tools or
   *  payload mutations injecting an active-content scheme.
   */
  url: z.string().min(1).refine(
    (u) => {
      if (u.startsWith('https://') || u.startsWith('http://')) return true
      if (u.startsWith('/') && !u.startsWith('//')) return true
      // Allow only safe image MIME types for data URIs — data:text/html + allow-same-origin is XSS.
      if (u.startsWith('data:image/svg+xml') ||
          u.startsWith('data:image/png') ||
          u.startsWith('data:image/jpeg') ||
          u.startsWith('data:image/gif') ||
          u.startsWith('data:image/webp')) return true
      return false
    },
    'URL must be http(s) absolute, safe data:image/ URI, or same-origin path starting with /',
  ).optional(),
  /**
   * Stage Manager renderer hint. When the share_screen tool fires with a
   * `mode` arg, the BFF PATCHes chats.stage_mode and the agent emits this
   * field alongside the URL so the FE can optimistically flip the renderer
   * on the next paint, without waiting for a chat-detail refetch.
   *   'spotlight' → multi-tile rail with active spotlight (chats.stage_mode = true)
   *   'focus'     → single full-bleed iframe (chats.stage_mode = false)
   * Values match the share_screen tool's `mode` arg byte-for-byte.
   */
  stageMode: z.enum(['spotlight', 'focus']).optional(),
})

export const MessageAdded = z.object({
  id: z.string().uuid(),
  chatId: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string(),
  /** True when emitted via the agent's persistTurn-failure fallback (no DB row).
   *  The frontend can use this to refetch chat-history later and reconcile, or
   *  to visually distinguish the bubble (e.g. dim it). */
  ephemeral: z.boolean().optional(),
})

export const BackgroundTaskUpdate = z.object({ summary: z.string() })
export const WorkerError = z.object({ message: z.string() })
export const WorkerHeartbeat = z.object({
  status: z.string(),
  elapsedMs: z.number(),
})

export type ResearchDispatch = z.infer<typeof ResearchDispatch>
export type ArtifactReady = z.infer<typeof ArtifactReady>
export type MessageAdded = z.infer<typeof MessageAdded>
export type BackgroundTaskUpdate = z.infer<typeof BackgroundTaskUpdate>
export type WorkerError = z.infer<typeof WorkerError>
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeat>
