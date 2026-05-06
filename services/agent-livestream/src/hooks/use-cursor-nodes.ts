import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import type { ApiProcess } from '@skill-networks/contracts/processes'
import type { ProcessStatus } from '@/lib/process-status'
import { apiFetch } from '@/lib/api-fetch'
import { useProjectId } from '@/hooks/use-project'

export type CursorInfo = {
  process_id: string
  process_name: string
}

export type CursorList = CursorInfo[]

export type ActiveProcess = {
  process_id: string
  process_name: string
  status: ProcessStatus
  skill_id: string | null
  skill_name: string | null
  current_epoch: number | null
  created_at: string
  progress: number | null
}

const EMPTY_PROCESSES: ApiProcess[] = []

/**
 * Fetches active/waiting processes from the BFF and assigns them to
 * outermost graph nodes (sm/md) for cursor display.
 */
export function useCursorNodes(
  resources: Resource[],
  focusedProcessId?: string | null,
  links?: ResourceLink[],
): {
  cursorMap: Map<string, CursorList>
  activeProcesses: ActiveProcess[]
} {
  const projectId = useProjectId()
  const { data: processes = EMPTY_PROCESSES } = useQuery<ApiProcess[]>({
    queryKey: ['processes', 'active', projectId],
    queryFn: async () => { return apiFetch(`/api/processes?status=active&project=${encodeURIComponent(projectId)}`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }) },
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  })

  return useMemo(() => {
    const resourceMap = new Map(resources.map((r) => [r.id, r]))

    // Build child→parent lookup from links so processes linked to off-graph
    // skill resources can resolve to their parent agent/user node
    const childToParent = new Map<string, string>()
    if (links) {
      for (const link of links) {
        // "runs" link: from=parent, to=child skill.
        // Assumes one parent per child (enforced by DB link_type_rules).
        // If duplicates exist, last writer wins — visible as cursor jumping to wrong node.
        if (link.link_type === 'runs' && resourceMap.has(link.from_id)) {
          childToParent.set(link.to_id, link.from_id)
        }
      }
    }

    // Fallback pool: outermost nodes for processes without a skill_resource_id
    const outer = resources.filter((r) => {
      const size = (r.config as { size?: string } | null)?.size ?? 'md'
      return size === 'sm' || size === 'md'
    })
    let fallbackIdx = 0

    const cursorMap = new Map<string, CursorList>()
    const activeProcesses: ActiveProcess[] = []

    for (const proc of processes) {
      if (!proc) continue
      const name = proc.name ?? `process-${proc.id.slice(0, 8)}`
      const status = (proc.status as ProcessStatus) ?? 'active'

      // Use skill_resource_id from DB if available; if not in graph, try parent via links
      let linked = proc.skill_resource_id ? resourceMap.get(proc.skill_resource_id) : null
      if (!linked && proc.skill_resource_id) {
        const parentId = childToParent.get(proc.skill_resource_id)
        if (parentId) linked = resourceMap.get(parentId) ?? null
      }
      const resource = linked ?? outer[fallbackIdx++]

      if (resource) {
        const isFocused = !focusedProcessId || proc.id === focusedProcessId
        if (isFocused) {
          const existing = cursorMap.get(resource.id) ?? []
          cursorMap.set(resource.id, [...existing, { process_id: proc.id, process_name: name }])
        }
      }

      activeProcesses.push({
        process_id: proc.id,
        process_name: name,
        status,
        skill_id: resource?.id ?? null,
        skill_name: resource?.name ?? null,
        current_epoch: proc.current_epoch ?? null,
        created_at: proc.created_at,
        progress: proc.progress ?? null,
      })
    }

    return { cursorMap, activeProcesses }
  }, [resources, processes, focusedProcessId, links])
}
