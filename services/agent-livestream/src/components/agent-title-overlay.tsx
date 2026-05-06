import { X } from 'lucide-react'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'

interface AgentTitleOverlayProps {
  process: ActiveProcess
  onDismiss: () => void
}

export function AgentTitleOverlay({ process, onDismiss }: AgentTitleOverlayProps) {
  return (
    <>
      {/* Agent name — top left */}
      <div className="absolute top-3 left-3 z-50 rounded-xl backdrop-blur-md bg-muted/30 border border-border/40 px-3 py-1.5">
        <span className="text-sm font-medium text-foreground">
          {process.process_name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
        </span>
      </div>

      {/* Dismiss — top right */}
      <button
        type="button"
        onClick={onDismiss}
        className="absolute top-3 right-3 z-50 flex items-center justify-center rounded-xl backdrop-blur-md bg-muted/30 border border-border/40 h-8 w-8 text-muted-foreground hover:text-foreground transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </>
  )
}
