import { z } from 'zod'

// EpochResult — raw wire type from BFF (snake_case field names because it reflects DB columns directly)
// DB columns: id, campaign_id (mapped to process_id on wire), epoch_number, status, cost,
//             duration_ms, session_id, workflow_run_id, state_snapshot (JSONB), started_at, completed_at
export const EpochResultSchema = z.object({
  id: z.string().uuid(),
  process_id: z.string().uuid(),  // mapped from campaign_id
  epoch_number: z.number(),
  status: z.string(),
  cost: z.number().nullable(),
  duration_ms: z.number().nullable(),
  session_id: z.string().nullable(),
  workflow_run_id: z.string().nullable(),
  state_snapshot: z.unknown(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
})

export type EpochResult = z.infer<typeof EpochResultSchema>
