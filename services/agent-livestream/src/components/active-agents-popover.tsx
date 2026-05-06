import { useState } from 'react'
import { Popover } from 'radix-ui'
import { Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentColor } from '@/lib/agent-colors'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'
import { STATUS_BADGE, STATUS_LABEL, type ProcessStatus } from '@/lib/process-status'

/** Discord-style composite: centered identity dot with solid status dot overlapping bottom-right. */
function AgentDot({ processId, status }: { processId: string; status: ProcessStatus }) {
  const color = agentColor(processId)
  return (
    <span className="relative flex h-5.5 w-5.5 shrink-0 items-center justify-center" title={STATUS_LABEL[status]}>
      <span className={`h-4 w-4 rounded-full ${color.bg}`} />
      <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-popover ${STATUS_BADGE[status]}`} />
    </span>
  )
}

interface ActiveAgentsPopoverProps {
  processes: ActiveProcess[]
  onSelect?: (process: ActiveProcess) => void
}

export function ActiveAgentsPopover({ processes, onSelect }: ActiveAgentsPopoverProps) {
  const [open, setOpen] = useState(false)

  function handleSelect(p: ActiveProcess) {
    setOpen(false)
    onSelect?.(p)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Users className="h-3.5 w-3.5" />
          Active agents
          {processes.length > 0 && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
              {processes.length}
            </span>
          )}
        </Button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-56 rounded-lg border bg-popover p-1 shadow-md outline-none"
        >
          {processes.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">No active agents</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {processes.map((p) => (
                <li key={p.process_id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 hover:bg-muted/50 text-left"
                    onClick={() => handleSelect(p)}
                  >
                    <AgentDot processId={p.process_id} status={p.status} />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{p.process_name}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
