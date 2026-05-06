import { queryOptions } from '@tanstack/react-query'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import { apiFetch } from '@/lib/api-fetch'

export interface GraphData {
  resources: Resource[]
  links: ResourceLink[]
}

export function graphQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: ['graph', projectId, { activeTypes: ['agent', 'user'] }] as const,
    staleTime: 30_000,
    queryFn: async (): Promise<GraphData> => {
      const r = await apiFetch(`/api/graph?types=agent&types=user&projectId=${encodeURIComponent(projectId)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json() as Promise<GraphData>
    },
  })
}
