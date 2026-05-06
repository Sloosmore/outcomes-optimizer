import { useSyncExternalStore } from 'react'
import { LineChart, Line } from 'recharts'
import { ChevronRight, Check, X, Moon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { ApiProcess } from '@skill-networks/contracts/processes'
import type { EpochResult } from '@skill-networks/contracts/epochs'
import { cn } from '@/lib/utils'
import { agentColor } from '@/lib/agent-colors'
import { STATUS_BADGE, formatProcessName, type ProcessStatus } from '@/lib/process-status'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'
import { apiFetch } from '@/lib/api-fetch'
import { mapStateSnapshot } from '@/lib/state-snapshot-mapper'

/** Subscribes to the system clock via useSyncExternalStore — the canonical React pattern for external stores. */
function useNow(intervalMs = 30_000): number {
  // Quantize to interval boundaries — useSyncExternalStore requires a stable cached value;
  // raw Date.now() returns a new value on every call and triggers an infinite loop.
  const snap = () => Math.floor(Date.now() / intervalMs) * intervalMs
  return useSyncExternalStore(
    (notify) => { const id = setInterval(notify, intervalMs); return () => clearInterval(id) },
    snap,
    snap,
  )
}

function formatElapsed(createdAt: string, now: number): string {
  const created = new Date(createdAt).getTime()
  if (Number.isNaN(created)) return '--'
  const ms = Math.max(0, now - created)
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem === 0 ? `${hrs}h` : `${hrs}h ${rem}m`
}

type HistoryPoint = { date: string; value: number }
export function MiniSparkline({ history }: { history: HistoryPoint[] }) {
  if (history.length < 2) return null
  return (
    <LineChart width={56} height={20} data={history} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
      <Line type="monotone" dataKey="value" stroke="currentColor" strokeWidth={1.5} dot={false} isAnimationActive={false} />
    </LineChart>
  )
}

/** Fitness ring — progress arc. Static blue stroke. */
export function ProgressRing({ value }: { value: number | null | undefined }) {
  const size = 16
  const stroke = 2
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r

  if (value == null) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle cx={size / 2} cy={size / 2} r={r}
          className="stroke-muted-foreground/30" fill="none"
          strokeWidth={stroke} strokeDasharray="2 2" />
      </svg>
    )
  }

  const clamped = Math.max(0, Math.min(100, value))
  const offset = circumference - (clamped / 100) * circumference
  const color = 'stroke-blue-500' // tokens-ok — task progress blue

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r}
        className="stroke-muted-foreground/20" fill="none" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r}
        className={color} fill="none" strokeWidth={stroke}
        strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round" />
    </svg>
  )
}

export function SectionHeader({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle}
      className="w-full flex items-center px-2 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
      <span>{label}</span>
      <ChevronRight className={cn('ml-1 h-3 w-3 shrink-0 transition-transform duration-150', open && 'rotate-90')} />
    </button>
  )
}

/** Smooth height-based collapse using CSS grid trick. */
export function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('grid transition-all duration-150 ease-in-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}> {/* tokens-ok — fr units have no token equivalent */}
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}

/** Composite dot: identity circle + status badge overlapping bottom-right. */
export function AgentDot({ processId, status }: { processId: string; status: ProcessStatus }) {
  const color = agentColor(processId)
  return (
    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
      <span className={`h-4 w-4 rounded-full ${color.bg}`} />
      <span className={`absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-background ${STATUS_BADGE[status]}`} />
    </span>
  )
}

function AgentListItem({ p, now, onSelect }: { p: ActiveProcess; now: number; onSelect: (p: ActiveProcess) => void }) {
  const { data: epochResult } = useQuery<EpochResult | null>({
    queryKey: ['epoch-latest', p.process_id],
    queryFn: () => apiFetch(`/api/processes/${p.process_id}/epochs/latest`).then(r => r.ok ? r.json() : null),
    refetchInterval: 10_000,
    staleTime: 5_000,
  })

  const fromEpoch = epochResult != null
    ? mapStateSnapshot(epochResult.state_snapshot).progress * 100
    : null
  const fromProcesses = p.progress != null ? p.progress * 100 : null
  const ringValue = fromEpoch ?? fromProcesses

  return (
    <button type="button" onClick={() => onSelect(p)}
      className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 hover:bg-muted/40 text-left transition-colors">
      {p.status === 'waiting'
        ? <Moon className="shrink-0 size-4 text-muted-foreground/50" />
        : <ProgressRing value={ringValue} />}
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground/70">{formatProcessName(p.process_name)}</p>
      <span className="shrink-0 text-xs font-mono text-muted-foreground/50 shimmer shimmer-repeat-delay-0">{formatElapsed(p.created_at, now)}</span>
    </button>
  )
}

export function AgentList({ processes, onSelect }: { processes: ActiveProcess[]; onSelect: (p: ActiveProcess) => void }) {
  const now = useNow(5_000)
  if (processes.length === 0) return <p className="px-2 py-1.5 text-xs text-muted-foreground/60">No tasks</p>
  return <>{processes.map((p) => <AgentListItem key={p.process_id} p={p} now={now} onSelect={onSelect} />)}</>
}

export function RecentTaskList({ processes }: { processes: ApiProcess[] }) {
  if (processes.length === 0) return <p className="px-2 py-1.5 text-xs text-muted-foreground/60">None in last 6h</p>
  return <>
    {processes.map((proc) => {
      const name = proc.name ?? `process-${proc.id.slice(0, 8)}`
      const isCompleted = proc.status === 'completed'
      return (
        <div key={proc.id} className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left">
          {isCompleted
            ? <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
            : <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground/60">{name}</p>
        </div>
      )
    })}
  </>
}

