// TanStack Router route files export Route (a config object, not a component) alongside the page component — fast-refresh pattern does not apply
/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { ArrowLeft } from 'lucide-react'
import { ActivityGraph } from '@/components/activity-graph'
import { ActivityFilter } from '@/components/activity-filter'
import { AgentLogPanel } from '@/components/agent-log-panel'
import { agentColor } from '@/lib/agent-colors'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import type { ApiProcessEventsResponse, ProcessEvent, ApiProcess } from '@skill-networks/contracts/processes'
import { DEFAULT_SEARCH_PARAMS } from '@/adapters/layout/registry'
import { apiFetch } from '@/lib/api-fetch'
import { EVENTS_PAGE_SIZE } from '@/constants'

export const Route = createFileRoute('/_authenticated/activity/$processId')({
  validateSearch: (search: Record<string, unknown>) => ({
    activeTypes: Array.isArray(search.activeTypes)
      ? search.activeTypes.filter((v): v is string => typeof v === 'string')
      : [],
  }),
  component: ActivityPage,
})

function ActivityPage() {
  const { processId } = Route.useParams()
  const { activeTypes } = Route.useSearch()
  const navigate = useNavigate()

  const { data: allProcesses = [] } = useQuery<ApiProcess[]>({
    queryKey: ['processes', 'all'],
    queryFn: async () => { return apiFetch('/api/processes').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }) },
  })
  const proc = allProcesses.find((p) => p.id === processId)
  const process = proc ? { process_id: proc.id, process_name: proc.name ?? processId.slice(0, 8), status: proc.status } : null

  const { data: eventsData } = useQuery<ApiProcessEventsResponse>({
    queryKey: ['process-events', processId],
    queryFn: async () => {
      const r = await apiFetch(`/api/process-events/${processId}?limit=${EVENTS_PAGE_SIZE}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    },
  })
  const events: ProcessEvent[] = eventsData?.events ?? []

  // visitPath: unique resource IDs in chronological order, oldest first
  // Events from unlinked processes have null resource_id — skip them here
  const visitPath = useMemo(() => {
    const seen = new Set<string>()
    const path: string[] = []
    for (const e of events) {
      if (e.resource_id && !seen.has(e.resource_id)) {
        seen.add(e.resource_id)
        path.push(e.resource_id)
      }
    }
    return path
  }, [events])

  // touchMap: first source recorded per resource (what the agent did with it)
  const touchMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const e of events) {
      if (e.resource_id && !m[e.resource_id]) m[e.resource_id] = e.source
    }
    return m
  }, [events])

  const typesQs = activeTypes.map((t) => `types=${encodeURIComponent(t)}`).join('&')
  const graphUrl = `/api/graph${typesQs ? `?${typesQs}` : ''}`

  const { data, isPending } = useQuery({
    queryKey: ['graph', { activeTypes }],
    queryFn: async () => { return apiFetch(graphUrl).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }) },
    staleTime: 60_000,
  })

  const allResources: Resource[] = useMemo(() => data?.resources ?? [], [data])
  const allLinks: ResourceLink[] = useMemo(() => data?.links ?? [], [data])

  // Show visited nodes + their 1-hop structural neighbors (the meaningful context)
  const visitedSet = useMemo(() => new Set(visitPath), [visitPath])

  const neighborIds = useMemo(() => {
    // Snapshot visitedSet before iterating so we expand exactly 1-hop, not cascade further
    const result = new Set(visitedSet)
    for (const link of allLinks) {
      if (visitedSet.has(link.from_id)) result.add(link.to_id)
      if (visitedSet.has(link.to_id)) result.add(link.from_id)
    }
    return result
  }, [visitedSet, allLinks])

  const resources = useMemo(
    () => allResources.filter((r) => neighborIds.has(r.id)),
    [allResources, neighborIds],
  )

  const links = useMemo(
    () => allLinks.filter((l) => neighborIds.has(l.from_id) && neighborIds.has(l.to_id)),
    [allLinks, neighborIds],
  )

  const color = agentColor(processId)
  const title = (process?.process_name ?? processId)
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="h-10 shrink-0 flex items-center gap-3 px-4 border-b">
        <button
          type="button"
          onClick={() => navigate({ to: '/', search: { ...DEFAULT_SEARCH_PARAMS, activeTypes: [] as string[] } })}
          className="flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className={`h-2 w-2 shrink-0 rounded-full ${color.bg}`} />
          <span className="text-sm font-medium truncate">{title}</span>
          <span className="text-xs text-muted-foreground shrink-0">· Activity Trail</span>
        </div>
        <ActivityFilter processId={processId} activeTypes={activeTypes} />
      </div>

      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 overflow-hidden">
          {isPending ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-muted-foreground text-sm">Loading…</p>
            </div>
          ) : (
            <ActivityGraph
              resources={resources}
              links={links}
              visitPath={visitPath}
              touchMap={touchMap}
              processId={processId}
            />
          )}
        </div>
        <div className="w-64 shrink-0 border-l flex flex-col overflow-hidden">
          <div className="h-8 shrink-0 flex items-center px-4 border-b">
            <span className="text-xs font-medium text-muted-foreground">Event Log</span>
          </div>
          <AgentLogPanel processId={processId} />
        </div>
      </div>
    </div>
  )
}
