import type { Node, NodeProps } from '@xyflow/react'
import { Handle, Position, useStore } from '@xyflow/react'
import type { Resource } from '@skill-networks/agent-events'
import type { CursorList } from '@/hooks/use-cursor-nodes'
import { BASE_SIZE, BASE_LABEL_WIDTH, selectZoom } from '@/lib/graph-constants'
import { cn } from '@/lib/utils'
import { formatSkillName } from '@/lib/process-status'
import { AgentOrb } from '@/components/ui/agent-orb'
import { Badge } from '@/components/ui/badge'

type SkillNodeData = { resource: Resource; cursors?: CursorList; onCursorClick?: (processId: string) => void; showOrb?: boolean }

const baseFontMap = { xl: 24, lg: 20, md: 16, sm: 12 } as const
const baseLabelFontMap = { xl: 16, lg: 14, md: 11, sm: 9 } as const
const baseLabelWidthMap = BASE_LABEL_WIDTH
const baseBorderMap = { xl: 10, lg: 8, md: 6, sm: 5 } as const

type NodeSize = 'xl' | 'lg' | 'md' | 'sm'

export function SkillNode({ data, selected }: NodeProps<Node<SkillNodeData, 'skillNode'>>) {
  const zoom = useStore(selectZoom)
  const { resource, cursors, onCursorClick, showOrb = true } = data
  const config = resource.config as { size?: string; value?: number | null; status?: string } | null
  const size = (config?.size ?? 'md') as NodeSize
  const value = config?.value
  const isRoot = size === 'xl'

  // Google Maps style: deeper nodes require more zoom to reveal.
  // Threshold per depth tier (size encodes depth: xl=root, lg=child, md=grandchild, sm=leaf)
  const labelThreshold = { xl: 0, lg: 0.38, md: 0.5, sm: 0.62 }[size]
  const valueThreshold = { xl: 0.5, lg: 0.55, md: 0.65, sm: 0.75 }[size]
  const labelOpacity = zoom >= labelThreshold ? 1 : 0
  const valueOpacity = zoom >= valueThreshold ? 1 : 0

  const ringClasses = [
    'relative rounded-full flex items-center justify-center shrink-0 border transition-colors overflow-hidden',
    selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : '',
    // Ring color: foreground for root, muted border for children
    isRoot ? 'border-foreground/80' : 'border-border',
  ].join(' ')

  const gs = 'var(--graph-scale, 1)'
  const dim = `calc(${BASE_SIZE[size]}px * ${gs})`
  const font = `calc(${baseFontMap[size]}px * ${gs})`
  const labelW = `calc(${baseLabelWidthMap[size]}px * ${gs})`
  const labelFont = `calc(${baseLabelFontMap[size]}px * ${gs})`
  const gap = `calc(8px * ${gs})`

  return (
     
    <div className="flex flex-col items-center cursor-default select-none" style={{ gap, width: dim }}>
      { }
      <div className={ringClasses} style={{ width: dim, height: dim, borderWidth: `calc(${baseBorderMap[size]}px * ${gs})` }}>
        <Handle type="target" position={Position.Left} className="opacity-0" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />
        <Handle type="source" position={Position.Left} className="opacity-0" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />
        {/* Orb fills the ring interior */}
        {showOrb && (
          <AgentOrb
            name={resource.id}
            size={BASE_SIZE[size]}
            cursors={cursors}
            active={!!(cursors && cursors.length > 0)}
            className="absolute inset-0 pointer-events-none"
          />
        )}
        {value != null && (
          <span className="relative z-10 font-semibold leading-none transition-opacity duration-200 text-white drop-shadow" style={{ opacity: valueOpacity, fontSize: font }}>
            {value}
          </span>
        )}
        {cursors && cursors.length > 0 && (
          <div className="absolute bottom-0 right-0 z-10 translate-x-1/4 translate-y-1/4 flex items-end">
            {cursors.map((c, i) => (
              <button
                key={c.process_id}
                type="button"
                aria-label={`Select agent ${c.process_name}`}
                className={cn('block cursor-pointer focus:outline-none', i > 0 && '-ml-3')}
                 
                style={{ zIndex: cursors.length - i }}
                onClick={(e) => { e.stopPropagation(); onCursorClick?.(c.process_id) }}
              >
                <span className="sr-only">{c.process_name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      { }
      <Badge
        variant="outline"
        className="h-auto font-medium text-center leading-tight transition-opacity duration-200 min-w-max"
        style={{ maxWidth: labelW, fontSize: labelFont, opacity: labelOpacity, padding: `calc(3px * ${gs}) calc(10px * ${gs})` }}
      >
        {formatSkillName(resource.name)}
      </Badge>
    </div>
  )
}
