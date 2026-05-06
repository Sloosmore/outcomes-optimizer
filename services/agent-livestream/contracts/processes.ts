import { z } from 'zod'

export const ProcessEventSchema = z.object({
  id: z.string(),
  process_id: z.string(),
  resource_id: z.string().uuid().nullable(),
  source: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  ts: z.string(),
  created_at: z.string().optional(),
})

export const ApiProcessSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  status: z.string(),
  current_epoch: z.number().nullable(),
  skill_resource_id: z.string().uuid().nullable(),
  updated_at: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  progress: z.number().min(0).max(1).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
})

export const ApiProcessesResponse = z.array(ApiProcessSchema)

export const ApiProcessEventsResponse = z.object({ events: z.array(ProcessEventSchema), total: z.number() })

export type ProcessEvent = z.infer<typeof ProcessEventSchema>
export type ApiProcess = z.infer<typeof ApiProcessSchema>
export type ApiProcessesResponse = z.infer<typeof ApiProcessesResponse>
export type ApiProcessEventsResponse = z.infer<typeof ApiProcessEventsResponse>
