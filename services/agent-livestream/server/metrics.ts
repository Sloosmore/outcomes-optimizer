import type { MetricsService } from '@skill-networks/database/services'
import type { ResourcesService } from '@skill-networks/database/services'
import type { ApiMetricsLatestResponse, ApiMetricsHistoryResponse } from '@skill-networks/contracts/metrics'

/**
 * Returns the latest snapshot per metric_key for a skill.
 * Deduplicates in-app after ordering by (metric_key, measured_at DESC).
 * When skillId is empty, returns latest snapshots across all skills.
 * If projectId (UUID) and resources are provided, fetches metrics for all skills in that project.
 */
export async function fetchLatestMetrics(
  metrics: MetricsService,
  skillId: string,
  projectId?: string,
  resources?: ResourcesService,
): Promise<ApiMetricsLatestResponse> {
  // If projectId provided, fetch metrics for all skills in that project
  if (projectId && resources) {
    const links = await resources.getLinks(projectId)
    if (links) {
      const skillIds = links
        .filter((l: { link_type: string }) => l.link_type === 'parent')
        .map((l: { to_id: string }) => l.to_id)
      if (skillIds.length === 0) return [] as unknown as ApiMetricsLatestResponse
      const allMetrics = (await Promise.all(skillIds.map((id: string) => metrics.getLatestSnapshots(id)))).flat()
      const seen = new Set<string>()
      // Service row type doesn't structurally overlap with ApiMetricsLatestResponse;
      // z.coerce.number() in the route's Zod schema handles value coercion at the boundary.
      return allMetrics.filter((row) => {
        const r = row as unknown as Record<string, unknown>
        const key = `${r['skill_resource_id'] ?? r['skill_id']}:${row.metric_key}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }) as unknown as ApiMetricsLatestResponse
    }
  }

  const data = await metrics.getLatestSnapshots(skillId || undefined)
  const seen = new Set<string>()
  // z.coerce.number() in ApiMetricsLatestResponseSchema handles string→number coercion at route boundary.
  return data.filter((row) => {
    if (seen.has(row.metric_key)) return false
    seen.add(row.metric_key)
    return true
  }) as unknown as ApiMetricsLatestResponse
}

/**
 * Returns the metric history for a single metric_key within a time window.
 */
export async function fetchMetricHistory(
  metrics: MetricsService,
  skillId: string,
  key: string,
  days: number,
): Promise<ApiMetricsHistoryResponse> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const data = await metrics.getHistoryWindow(skillId, key, cutoff)
  return data as unknown as ApiMetricsHistoryResponse
}
