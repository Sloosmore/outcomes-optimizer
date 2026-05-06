import type { Node, NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import {
  KeyRound, Globe, Database, Server, User, Archive,
  Shield, Zap, Clock, HelpCircle,
} from 'lucide-react'
import type { Resource } from '@skill-networks/agent-events'

export type OntologyNodeData = {
  resource: Resource
  isVisited: boolean
  touchSource?: string  // e.g. "proxy.credential_fetch"
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconType = React.ComponentType<any>

const TYPE_CONFIG: Record<string, { icon: IconType; border: string; text: string }> = {
  credential: { icon: KeyRound,  border: 'border-l-blue-500',    text: 'text-blue-500'    }, // tokens-ok
  app:        { icon: Globe,     border: 'border-l-violet-500',  text: 'text-violet-500'  }, // tokens-ok
  database:   { icon: Database,  border: 'border-l-emerald-500', text: 'text-emerald-500' }, // tokens-ok
  deployment: { icon: Server,    border: 'border-l-orange-500',  text: 'text-orange-500'  }, // tokens-ok
  identity:   { icon: User,      border: 'border-l-rose-500',    text: 'text-rose-500'    }, // tokens-ok
  bucket:     { icon: Archive,   border: 'border-l-cyan-500',    text: 'text-cyan-500'    }, // tokens-ok
  proxy:      { icon: Shield,    border: 'border-l-yellow-500',  text: 'text-yellow-500'  }, // tokens-ok
  skill:      { icon: Zap,       border: 'border-l-indigo-500',  text: 'text-indigo-500'  }, // tokens-ok
  cron:       { icon: Clock,     border: 'border-l-gray-400',    text: 'text-gray-400'    }, // tokens-ok
}

function formatSource(source: string): string {
  // "proxy.credential_fetch" → "via proxy"
  // "api.github" → "via github api"
  const parts = source.split('.')
  if (parts[0] === 'proxy') return 'via proxy'
  if (parts[0] === 'db') return 'via database'
  if (parts[0] === 'api') return `via ${parts[1] ?? ''} api`
  return source
}

export function OntologyNode({ data }: NodeProps<Node<OntologyNodeData, 'ontologyNode'>>) {
  const { resource, isVisited, touchSource } = data
  const cfg = TYPE_CONFIG[resource.type] ?? { icon: HelpCircle, border: 'border-l-border', text: 'text-muted-foreground' }
  const Icon = cfg.icon

  return (
    <div
      className={[
        'w-48 rounded border border-border/50 bg-card shadow-sm border-l-2',
        cfg.border,
        isVisited ? '' : 'opacity-40',
      ].join(' ')}
    >
      {/* Centered invisible handles for edge connections */}
      { }
      <Handle type="target" position={Position.Left} className="opacity-0" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />
      { }
      <Handle type="source" position={Position.Left} className="opacity-0" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />

      <div className="flex items-start gap-2 px-3 py-2">
        <Icon className={['h-3.5 w-3.5 mt-0.5 shrink-0', cfg.text].join(' ')} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground leading-tight truncate">
            {resource.name}
          </p>
          <p className="text-xs text-muted-foreground leading-tight truncate">
            {resource.type}
            {touchSource ? ` · ${formatSource(touchSource)}` : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
