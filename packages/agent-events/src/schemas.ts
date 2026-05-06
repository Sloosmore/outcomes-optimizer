import { z } from 'zod'

export const AgentEventSchema = z.object({
  id: z.string().uuid(),
  process_id: z.string().uuid(),
  process_name: z.string(),
  resource_id: z.string().uuid().nullable(),
  source: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  ts: z.string().datetime({ offset: true })
})
export type AgentEvent = z.infer<typeof AgentEventSchema>

export const ResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()).nullable()
})
export type Resource = z.infer<typeof ResourceSchema>

export const ResourceLinkSchema = z.object({
  id: z.string(),
  from_id: z.string(),
  to_id: z.string(),
  link_type: z.string()
})
export type ResourceLink = z.infer<typeof ResourceLinkSchema>
