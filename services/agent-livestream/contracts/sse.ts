import { z } from 'zod'

export const RunStartedEventSchema = z.object({
  type: z.literal('RUN_STARTED'),
  threadId: z.string(),
  runId: z.string(),
})

export const TextChunkEventSchema = z.object({
  type: z.literal('TEXT_MESSAGE_CONTENT'),
  messageId: z.string(),
  delta: z.string(),
})

export const RunErrorEventSchema = z.object({
  type: z.literal('RUN_ERROR'),
  message: z.string(),
})

export const ArtifactEventSchema = z.object({
  type: z.literal('ARTIFACT'),
  port: z.number(),
  label: z.string(),
  path: z.string().optional(),
  url: z.string(),
})

export const SSEEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  TextChunkEventSchema,
  RunErrorEventSchema,
  ArtifactEventSchema,
])

export type SSEEvent = z.infer<typeof SSEEventSchema>
