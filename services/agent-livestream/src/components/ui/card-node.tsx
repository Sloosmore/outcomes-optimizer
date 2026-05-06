import { cva } from 'class-variance-authority'
import type { Node, NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import type { Resource } from '@skill-networks/agent-events'
import type { CursorList } from '@/hooks/use-cursor-nodes'
import { cn } from '@/lib/utils'
import { formatSkillName } from '@/lib/process-status'
import { AgentOrb } from '@/components/ui/agent-orb'

type CardNodeData = {
  resource: Resource
  cursors?: CursorList
  onCursorClick?: (processId: string) => void
  showOrb?: boolean
}

type NodeSize = 'xl' | 'lg' | 'md' | 'sm'

const cardBody = cva(
  'rounded-2xl border bg-card text-card-foreground shadow-sm flex flex-col items-center gap-0.5',
  {
    variants: {
      size: {
        xl: 'w-48 px-5 pb-4 pt-7',
        lg: 'w-44 px-4 pb-3.5 pt-6',
        md: 'w-40 px-3.5 pb-3 pt-5',
        sm: 'w-32 px-2.5 pb-2 pt-4',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

const avatarContainer = cva('overflow-hidden shrink-0 border-2 border-border', {
  variants: {
    size: {
      xl: 'size-11',
      lg: 'size-10',
      md: 'size-9',
      sm: 'size-7',
    },
    shape: {
      circle: 'rounded-full',
      square: 'rounded-lg',
    },
  },
  defaultVariants: { size: 'md', shape: 'circle' },
})

type CardConfig = {
  size?: string
  value?: number | null
  description?: string | null
  display_name?: string | null
  avatar_url?: string | null
}

// Slack-style palette — deterministic color from resource ID
const AVATAR_COLORS = [
  'bg-rose-400', 'bg-orange-400', 'bg-amber-400', 'bg-teal-400',
  'bg-cyan-400', 'bg-sky-400', 'bg-blue-400', 'bg-indigo-400',
  'bg-violet-400', 'bg-fuchsia-400',
] as const

function hashToIndex(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Math.abs(h) % AVATAR_COLORS.length
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return (parts[0]?.[0] ?? '?').toUpperCase()
}

export function CardNode({ data, selected }: NodeProps<Node<CardNodeData, 'cardNode'>>) {
  const { resource, cursors, showOrb = true } = data
  const config = resource.config as CardConfig | null
  const size = (config?.size ?? 'md') as NodeSize
  const description = config?.description
  const displayName = config?.display_name
  const isActive = !!(cursors && cursors.length > 0)
  const isUser = resource.type === 'user'

  return (
    <div className="flex flex-col items-center cursor-default select-none">
      {showOrb && (
        <div className="relative -mb-4 z-10">
          <div className={cn(avatarContainer({ size, shape: isUser ? 'square' : 'circle' }))}>
            {isUser ? (
              // tokens-ok — deterministic Slack-style avatar color per user
              <div className={cn('flex items-center justify-center h-full w-full text-white font-bold text-sm', AVATAR_COLORS[hashToIndex(resource.id)])}>
                {getInitials(displayName ?? resource.name)}
              </div>
            ) : (
              <AgentOrb
                name={resource.id}
                cursors={cursors}
                active={isActive}
                className="h-full w-full"
              />
            )}
          </div>
          {isActive && (
            // tokens-ok — matches STATUS_BADGE.active; green status dot on active node
            <span className="absolute bottom-0 -right-0.5 flex items-center justify-center size-2.5 rounded-full bg-emerald-400 ring-1 ring-card" />
          )}
        </div>
      )}

      <div className={cn(
        cardBody({ size }),
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}>
        {/* Handles at card center — edge routing offsets from here. isConnectable=false
            because interactive edge creation is not supported on card nodes. */}
        <Handle type="target" position={Position.Left} className="opacity-0" isConnectable={false}
          style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />
        <Handle type="source" position={Position.Left} className="opacity-0" isConnectable={false}
          style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />

        <p className="text-xs font-semibold text-secondary-foreground w-full text-center leading-tight">
          {displayName ?? formatSkillName(resource.name)}
        </p>

        {description && (
          <p className="text-2xs text-muted-foreground text-center leading-tight truncate w-full">
            {description}
          </p>
        )}

      </div>
    </div>
  )
}
