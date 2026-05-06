import type { Node, NodeProps } from '@xyflow/react'
import { Badge } from '@/components/ui/badge'
import { AskUserPanel, type AskUserQuestion } from '@/components/ask-user-panel'

const AGENT_COLORS = [
  { fill: 'text-rose-500', bg: 'bg-rose-500' },
  { fill: 'text-blue-500', bg: 'bg-blue-500' },
  { fill: 'text-emerald-500', bg: 'bg-emerald-500' },
  { fill: 'text-orange-500', bg: 'bg-orange-500' },
  { fill: 'text-violet-500', bg: 'bg-violet-500' },
  { fill: 'text-cyan-500', bg: 'bg-cyan-500' },
  { fill: 'text-red-500', bg: 'bg-red-500' },
  { fill: 'text-yellow-400', bg: 'bg-yellow-400' },
] as const

function hashToIndex(processId: string): number {
  let hash = 0
  for (let i = 0; i < processId.length; i++) {
    hash = ((hash << 5) - hash + processId.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % AGENT_COLORS.length
}

export type CursorNodeData = {
  process_id: string
  process_name: string
  resource_id: string | null
  /**
   * When set, the cursor's small process-name pill is replaced with an
   * expanded multi-question panel — used for the `ask_user` tool. The parent
   * decides when to populate this (e.g. on receiving an `ask_user` agent
   * event) and when to clear it (e.g. on user response or 3-minute timeout).
   */
  askUser?: { questions: AskUserQuestion[] }
}

export function AgentCursorNode({ data }: NodeProps<Node<CursorNodeData, 'cursorNode'>>) {
  const color = AGENT_COLORS[hashToIndex(data.process_id)]

  return (
    <div
      className={`pointer-events-none ${color.fill}`}
      data-cursor-process={data.process_id}
      data-cursor-name={data.process_name}
      data-cursor-node={data.resource_id}
    >
      <svg
        width="16"
        height="22"
        viewBox="0 0 16 22"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="drop-shadow-md"
      >
        <path
          d="M0 0L16 12.5L8.5 13.5L12 22L8 21L5 13.5L0 17.5V0Z"
          className="fill-current"
        />
      </svg>
      {data.askUser ? (
        <AskUserPanel
          processName={data.process_name}
          questions={data.askUser.questions}
          badgeBgClass={color.bg}
          className="mt-1"
        />
      ) : (
        <Badge
          variant="secondary"
          className={`mt-0.5 whitespace-nowrap text-white border-0 ${color.bg}`}
        >
          {data.process_name}
        </Badge>
      )}
    </div>
  )
}
