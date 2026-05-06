import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAgentEvents } from '@/hooks/use-agent-events'
import { agentColor } from '@/lib/agent-colors'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'

interface AgentFocusCardProps {
  process: ActiveProcess
  onDismiss: () => void
}

export function AgentFocusCard({ process, onDismiss }: AgentFocusCardProps) {
  const events = useAgentEvents(process.process_id)
  const color = agentColor(process.process_id)

  return (
    <div className="absolute bottom-4 right-4 z-50 w-96 rounded-lg border border-border/60 bg-card shadow-2xl overflow-hidden font-mono">

      {/* Identity accent bar — agent color strip */}
      <div className={`h-0.5 ${color.bg}`} />

      {/* Unit header */}
      <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-bold uppercase tracking-widest ${color.fill}`}>
              {process.process_name}
            </span>
            {/* tokens-ok — live signal indicator */}
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />{/* tokens-ok — live pulse */}
              <span className="text-xs tracking-widest text-emerald-500 font-bold">LIVE</span>{/* tokens-ok — live label */}
            </span>
          </div>
          <p className="text-xs text-muted-foreground tracking-wide mt-0.5 truncate">
            {process.skill_name}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Metadata grid */}
      <div className="mx-4 mb-2 grid grid-cols-3 gap-3 rounded border border-border/40 px-3 py-2">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Unit</p>
          <p className="text-xs text-foreground truncate">{process.process_id.slice(0, 8)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Events</p>
          <p className="text-xs text-foreground">{events.length}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Status</p>
          <p className={`text-xs font-bold ${color.fill}`}>{process.status.toUpperCase()}</p>
        </div>
      </div>

      {/* Feed label */}
      <div className="px-4 pb-1 flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">Signal Feed</span>
      </div>

      {/* Event log */}
      <div className="mx-4 mb-2 max-h-48 overflow-y-auto rounded border border-border/40">
        {events.length === 0 ? (
          <p className="py-6 text-center text-xs tracking-widest text-muted-foreground">
            — AWAITING SIGNAL —
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border/30">
            {events.map((event) => (
              <div key={event.id} className="flex items-start gap-3 px-3 py-1.5 hover:bg-muted/30">
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {new Date(event.ts).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                <span className={`shrink-0 text-xs font-bold uppercase tracking-wide ${color.fill}`}>
                  {event.source}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer action */}
      <div className="border-t border-border/40 px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full text-xs tracking-widest uppercase text-muted-foreground"
        >
          → View Full Trace
        </Button>
      </div>
    </div>
  )
}
