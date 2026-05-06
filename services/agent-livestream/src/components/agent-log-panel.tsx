import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { ApiProcessEventsResponse, ProcessEvent } from '@skill-networks/contracts/processes'
import { apiFetch } from '@/lib/api-fetch'
import { EVENTS_PAGE_SIZE, EVENTS_POLL_INTERVAL_MS } from '@/constants'

interface AgentLogPanelProps {
  processId: string
}

function EventRow({ event }: { event: ProcessEvent }) {
  const [expanded, setExpanded] = useState(false)
  const hasPayload = event.payload != null && Object.keys(event.payload as object).length > 0

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => hasPayload && setExpanded((v) => !v)}
        className="w-full px-4 py-2.5 flex flex-col gap-0.5 text-left hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-1">
          {hasPayload ? (
            expanded
              ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          ) : (
            <span className="h-3 w-3 shrink-0" />
          )}
          <p className="text-xs font-mono text-foreground/80 truncate">{event.source}</p>
        </div>
        <p className="text-xs text-muted-foreground/60 tabular-nums pl-4">
          {new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </p>
      </button>
      {expanded && hasPayload && (
        <pre className="px-4 pb-2.5 text-xs font-mono text-muted-foreground/80 whitespace-pre-wrap break-all bg-muted/20">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function AgentLogPanel({ processId }: AgentLogPanelProps) {
  const { data, isPending } = useQuery<ApiProcessEventsResponse>({
    queryKey: ['process-events', processId],
    queryFn: async () => {
      const r = await apiFetch(`/api/process-events/${processId}?limit=${EVENTS_PAGE_SIZE}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    },
    refetchInterval: EVENTS_POLL_INTERVAL_MS,
  })
  const events: ProcessEvent[] = data?.events ?? []

  if (isPending) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {events.length === 0 ? (
        <p className="px-4 py-8 text-xs text-muted-foreground/60 text-center">No events yet</p>
      ) : (
        <div className="flex flex-col">
          {[...events].reverse().map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}
