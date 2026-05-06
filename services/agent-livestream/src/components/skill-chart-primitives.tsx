/* eslint-disable react-refresh/only-export-components */
import { AreaChart, Area, Tooltip, ResponsiveContainer, ReferenceLine, YAxis } from 'recharts'
import type { Resource } from '@skill-networks/agent-events'
import { formatSkillName } from '@/lib/process-status'

export type SkillConfig = {
  metric?: string
  description?: string
  current?: number | null
  target?: number | null
  unit?: string | null
  chart?: { type: string; height: number; scale?: 'linear' | 'log' }
  /** Max decimal places for metric display. Default: 2 */
  decimals?: number
  history?: { date: string; value: number }[]
  size?: string
}

export function fmtValue(v: number | null | undefined, decimals = 2): string {
  if (v == null) return ''
  return Number.isInteger(v) ? String(v) : v.toFixed(decimals)
}

export function ChartTooltip({ active, payload, unit, decimals = 2 }: { active?: boolean; payload?: { value: number; payload: { date: string } }[]; unit?: string | null; decimals?: number }) {
  if (!active || !payload?.length) return null
  const rawDate = payload[0].payload.date
  const date = rawDate ? new Date(`${rawDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="text-muted-foreground">{date}</p>
      <p className="font-mono font-semibold text-foreground">{fmtValue(payload[0].value, decimals)}{unit ? ` ${unit}` : ''}</p>
    </div>
  )
}

export function MetricChart({ resource, compact }: { resource: Resource; compact?: boolean }) {
  const config = resource.config as SkillConfig | null
  if (!config?.chart || !config.history?.length) return null

  const gradientId = `grad-${resource.id}`
  const labelCls = compact ? 'text-xs' : 'text-sm'
  const valueCls = compact ? 'text-xs' : 'text-sm'

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <p className={`${labelCls} font-medium text-muted-foreground`}>{formatSkillName(resource.name)}</p>
        {config.current != null && (
          <span className={`${valueCls} font-mono font-semibold text-muted-foreground`}>
            {fmtValue(config.current, config.decimals)}{config.unit ? ` ${config.unit}` : ''}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={Math.max(config.chart.height, 64)} className="mt-2">
        <AreaChart data={config.history} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="currentColor" stopOpacity={0.3} />
              <stop offset="95%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis
            scale={config.chart.scale ?? 'linear'}
            domain={config.target != null ? [config.chart.scale === 'log' ? 1 : 0, config.target * 1.1] : config.chart.scale === 'log' ? [1, 'auto'] : undefined}
            hide
          />
          <Tooltip
            content={<ChartTooltip unit={config.unit} decimals={config.decimals} />}
            cursor={{ stroke: 'currentColor', strokeWidth: 1, strokeDasharray: '3 3' }} // tokens-ok — SVG stroke has no Tailwind equivalent
          />
          {config.target != null && (
            <ReferenceLine y={config.target} stroke="currentColor" strokeDasharray="3 3" strokeOpacity={0.4} />
          )}
          <Area type="monotone" dataKey="value" stroke="currentColor" strokeWidth={1.5}
            fill={`url(#${gradientId})`} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
