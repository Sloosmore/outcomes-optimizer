import type { Node, NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import { User } from 'lucide-react'
import type { Resource } from '@skill-networks/agent-events'

type UserNodeData = {
  resource: Resource
  currentAuthUuid: string | null
  avatarUrl: string | null
}

export function UserNode({ data, selected }: NodeProps<Node<UserNodeData, 'userNode'>>) {
  const { resource, currentAuthUuid, avatarUrl } = data
  const isSelf = resource.name === `user:${currentAuthUuid}`
  const displayName = (resource.config?.display_name as string | undefined)
  const label = isSelf
    ? displayName ? `you (${displayName})` : 'you'
    : displayName ?? resource.name

  return (
    <div
      data-node-id={resource.id}
      className={`w-20 h-20 flex flex-col items-center justify-center rounded-full border-2 border-primary bg-card text-card-foreground shadow-sm cursor-default select-none overflow-hidden p-1 ${selected ? 'ring-2 ring-primary' : ''}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="opacity-0"
        style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
      />
      <Handle
        type="source"
        position={Position.Left}
        className="opacity-0"
        style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
      />
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={label}
          className="w-10 h-10 rounded-full object-cover"
        />
      ) : (
        <User className="w-8 h-8 text-primary" />
      )}
      <p className="font-semibold text-xs text-center leading-tight truncate w-full px-1 mt-1">
        {label}
      </p>
    </div>
  )
}
