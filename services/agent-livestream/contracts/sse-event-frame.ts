import { z } from 'zod'

/**
 * SSE event frame emitted on `GET /api/events?projectId=<uuid>`.
 * One frame per agent_events INSERT, scoped to the requested project.
 * Distinct from `sse.ts` which carries chat-stream SSE events (RUN_STARTED, etc.).
 *
 * Full payload is intentionally excluded — cursor animation only needs source + process_id.
 * Forwarding raw agent_events.payload to the browser would expose tool inputs
 * (shell commands, file contents) to all project members.
 *
 * `tokens` is the sole payload field forwarded — used as a scalar for cursor impulse
 * magnitude. Extracted server-side from token_usage events' `total_tokens`.
 */
export const SseEventFrameSchema = z.object({
  source: z.string(),
  process_id: z.string().uuid(),
  ts: z.string().datetime(),
  tokens: z.number().optional(),
})

export type SseEventFrame = z.infer<typeof SseEventFrameSchema>
