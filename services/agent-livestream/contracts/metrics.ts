import { z } from 'zod'

export const ApiMetricSnapshotSchema = z.object({
  metric_key: z.string(),
  value: z.coerce.number().nullable(),
  measured_at: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

export const ApiMetricsLatestResponseSchema = z.array(ApiMetricSnapshotSchema)
export const ApiMetricsHistoryResponseSchema = z.array(ApiMetricSnapshotSchema)

export type ApiMetricSnapshot = z.infer<typeof ApiMetricSnapshotSchema>
export type ApiMetricsLatestResponse = z.infer<typeof ApiMetricsLatestResponseSchema>
export type ApiMetricsHistoryResponse = z.infer<typeof ApiMetricsHistoryResponseSchema>
