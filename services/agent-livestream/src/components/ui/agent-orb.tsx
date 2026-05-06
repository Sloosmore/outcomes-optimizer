import { useMemo } from 'react'
import { agentColor } from '@/lib/agent-colors'
import { Orb } from './elevenlabs-orb'
import type { AgentState } from './elevenlabs-orb'
import type { CursorList } from '@/hooks/use-cursor-nodes'

interface AgentOrbProps {
  name: string
  size?: number // kept for API compat — sizing is CSS-driven via className
  cursors?: CursorList
  active?: boolean
  className?: string
}

export function AgentOrb({ name, cursors, active = false, className }: AgentOrbProps) {
  const colors = useMemo((): [string, string] => {
    // Active: match the first cursor's sidebar color for visual consistency
    const id = (cursors && cursors.length > 0) ? cursors[0].process_id : name
    const c = agentColor(id)
    return [c.hex, c.hex2]
  }, [name, cursors])

  // Active agents are "listening" (steady, present) rather than "talking" (loud).
  // This is a monitoring view, not a voice call.
  const agentState: AgentState = active ? 'listening' : null

  return (
    <div className={className}>
      <Orb colors={colors} agentState={agentState} />
    </div>
  )
}
