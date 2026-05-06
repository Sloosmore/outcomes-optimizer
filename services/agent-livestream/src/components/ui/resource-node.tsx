import type { Node, NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import type { Resource } from '@skill-networks/agent-events'

type ResourceNodeData = { resource: Resource }

export function ResourceNode({ data, selected }: NodeProps<Node<ResourceNodeData, 'resourceNode'>>) {
  const { resource } = data

  return (
    <div
      data-node-id={resource.id}
      className={`w-20 h-20 flex flex-col items-center justify-center rounded-lg border bg-card text-card-foreground shadow-sm cursor-default select-none overflow-hidden p-1 dark:bg-zinc-800 dark:border-zinc-700 ${selected ? 'ring-2 ring-primary' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />
      <Handle type="source" position={Position.Left} className="opacity-0" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />
      <p className="font-semibold text-xs text-center leading-tight truncate w-full px-1">
        {resource.name}
      </p>
      <p className="text-xs text-muted-foreground text-center truncate w-full px-1 dark:text-zinc-400">
        {resource.type}
      </p>
    </div>
  )
}
