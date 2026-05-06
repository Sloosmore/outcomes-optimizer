import { z } from 'zod'

export const ChatSummary = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
})

/**
 * Accepted URL forms for artifact tiles and PATCH requests:
 *   - https:// / http:// absolute (sandbox artifacts, public links, local dev)
 *   - / root-relative same-origin path (dispatch tool, /run/123 style)
 * Rejects protocol-relative //evil.com, javascript:, data:, file:, etc.
 */
function isAcceptedArtifactUrl(u: string): boolean {
  if (u.startsWith('https://') || u.startsWith('http://')) return true
  if (u.startsWith('/') && !u.startsWith('//')) return true
  return false
}
const ACCEPTED_URL_MESSAGE = 'URL must be http(s) absolute or a same-origin path starting with /'
const acceptedArtifactUrlSchema = z.string().refine(isAcceptedArtifactUrl, ACCEPTED_URL_MESSAGE)

/**
 * Stage Manager tile entry. Object shape (not bare string) leaves room for
 * future metadata (title, favicon) without a migration or contract break.
 */
export const ArtifactTile = z.object({
  url: acceptedArtifactUrlSchema,
})
/** Server-side cap on rail length. Index 0 is the active tile. */
export const ARTIFACT_TILES_MAX = 4
export const ArtifactTilesArray = z.array(ArtifactTile).max(ARTIFACT_TILES_MAX)

export const ChatDetail = ChatSummary.extend({
  /** Ordered tile rail. Index 0 = active. */
  artifactTiles: ArtifactTilesArray,
  /** Renderer toggle: true → Stage Manager (multi-iframe rail); false → single full-bleed iframe. */
  stageMode: z.boolean(),
})

export const MessageRow = z.object({
  id: z.string().uuid(),
  chatId: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string(),
})

export const TokenResponse = z.object({
  token: z.string(),
  expiresAt: z.string(),
})

export type ChatSummary = z.infer<typeof ChatSummary>
export type ChatDetail = z.infer<typeof ChatDetail>
export type ArtifactTile = z.infer<typeof ArtifactTile>
export type MessageRow = z.infer<typeof MessageRow>
export type TokenResponse = z.infer<typeof TokenResponse>

export const ChatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(50000),
})
export const PostChatBody = z.object({
  chatId: z.union([z.literal('new'), z.string().uuid()]).optional(),
  messages: z.array(ChatMessage).min(1).max(50),
})
export type ChatMessage = z.infer<typeof ChatMessage>
export type PostChatBody = z.infer<typeof PostChatBody>

export const ToolDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
})
export const ApiChatConfigResponse = z.object({
  tools: z.array(ToolDefSchema),
  systemPrompt: z.string(),
})
export type ToolDefSchema = z.infer<typeof ToolDefSchema>
export type ApiChatConfigResponse = z.infer<typeof ApiChatConfigResponse>

/**
 * PATCH /api/chats/:id/artifact — adds or promotes a URL on the rail.
 * `port` is accepted (legacy emitters still send it) but ignored server-side.
 */
export const ApiArtifactPatchRequest = z.object({
  // port is deprecated and ignored server-side. Voice-agent emitters
  // (claude-code-tool.ts) send 0 as a placeholder. Tightening to >= 1 400's
  // every PATCH and silently breaks artifact persistence.
  port: z.number().int().min(0).max(65535).nullable().optional(),
  url: acceptedArtifactUrlSchema.nullable().optional(),
})
export const ApiArtifactPatchResponse = z.object({ ok: z.boolean() })
export type ApiArtifactPatchRequest = z.infer<typeof ApiArtifactPatchRequest>
export type ApiArtifactPatchResponse = z.infer<typeof ApiArtifactPatchResponse>

/**
 * POST /api/chats/:id/artifact/activate — promotes an existing rail URL to
 * index 0. Errors 400 if the URL is not already on the rail.
 */
export const ApiArtifactActivateRequest = z.object({
  url: acceptedArtifactUrlSchema,
})
export const ApiArtifactActivateResponse = z.object({ ok: z.boolean() })
export type ApiArtifactActivateRequest = z.infer<typeof ApiArtifactActivateRequest>
export type ApiArtifactActivateResponse = z.infer<typeof ApiArtifactActivateResponse>

/**
 * PATCH /api/chats/:id/stage-mode — flip the renderer toggle.
 */
export const ApiStageModePatchRequest = z.object({
  enabled: z.boolean(),
})
export const ApiStageModePatchResponse = z.object({ ok: z.boolean() })
export type ApiStageModePatchRequest = z.infer<typeof ApiStageModePatchRequest>
export type ApiStageModePatchResponse = z.infer<typeof ApiStageModePatchResponse>
