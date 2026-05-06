import { useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import type { ApiOrgResponse } from '@skill-networks/contracts/org'

// Returns the project name from the URL segment /p/$projectName.
// All components must use this hook — never call useParams() directly for project.
// projectId variable kept for backwards compatibility — but the value is now the project NAME
export function useProjectId(): string {
  const params = useParams({ strict: false })
  // projectId variable kept for backwards compatibility — but the value is now the project NAME
  const projectId = (params as { projectName?: string }).projectName ?? ''
  return projectId
}

// Returns the project UUID by resolving the project name via cached org query.
// Use this for API calls that require a UUID (e.g. /api/graph?projectId=<uuid>).
export function useProjectUuid(): string {
  const projectName = useProjectId()
  const { data } = useQuery<ApiOrgResponse>({
    queryKey: ['org'],
    queryFn: () => apiFetch('/api/org').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
  return data?.projects.find((p) => p.name === projectName)?.id ?? ''
}
