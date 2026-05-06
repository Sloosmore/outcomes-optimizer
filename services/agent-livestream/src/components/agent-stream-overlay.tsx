import { useRef, useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAgentEvents } from '@/hooks/use-agent-events'
import { agentColor } from '@/lib/agent-colors'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'

interface AgentStreamOverlayProps {
  process: ActiveProcess
  onDismiss: () => void
}

export function AgentStreamOverlay({ process, onDismiss }: AgentStreamOverlayProps) {
  const events = useAgentEvents(process.process_id)
  const color = agentColor(process.process_id)
  const [message, setMessage] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // Scroll to newest event — syncs DOM scroll position, no React setState
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex w-72 flex-col pointer-events-none">
      {/* Gradient fade at top — oldest events dissolve into the graph */}
      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-card to-transparent z-10 pointer-events-none" />

      {/* Scrollable event feed — pointer-events-auto so it's scrollable */}
      <div className="flex-1 overflow-y-auto px-3 pt-8 pointer-events-auto [scrollbar-width:none]">
        <div className="flex flex-col gap-1 pb-2 font-mono">
          {events.length === 0 ? (
            <p className="py-12 text-center text-xs tracking-widest text-muted-foreground/50">
              — awaiting signal —
            </p>
          ) : (
            events.map((event) => (
              <div
                key={event.id}
                className="group flex items-start gap-2 rounded px-2 py-1 hover:bg-card/60"
              >
                <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground/60">
                  {new Date(event.ts).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                <span className={`text-xs font-semibold uppercase tracking-wide ${color.fill}`}>
                  {event.source}
                </span>
              </div>
            ))
          )}
          {/* Scroll anchor */}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Bottom controls — always visible */}
      <div className="pointer-events-auto flex flex-col gap-1.5 border-t border-border/30 bg-card/80 backdrop-blur-sm px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-start text-xs text-muted-foreground hover:text-foreground tracking-wide"
          onClick={onDismiss}
        >
          → View agent live
        </Button>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Send message…"
            className="h-7 flex-1 rounded border border-border/40 bg-transparent px-2.5 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-border font-mono"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            disabled={!message.trim()}
          >
            <Send className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}
