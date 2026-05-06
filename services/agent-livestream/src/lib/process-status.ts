export type ProcessStatus = 'pending' | 'active' | 'paused' | 'waiting' | 'completed' | 'failed'

export const STATUS_BADGE: Record<ProcessStatus, string> = {
  active:    'bg-emerald-500',   // tokens-ok — fixed real-world status state
  pending:   'bg-muted-foreground',
  waiting:   'bg-yellow-500',   // tokens-ok — fixed real-world status state
  paused:    'bg-orange-500',   // tokens-ok — fixed real-world status state
  completed: 'bg-blue-500',    // tokens-ok — fixed real-world status state
  failed:    'bg-red-500',     // tokens-ok — fixed real-world status state
}

export const STATUS_LABEL: Record<ProcessStatus, string> = {
  active: 'Active', pending: 'Pending', waiting: 'Sleeping',
  paused: 'Paused', completed: 'Completed', failed: 'Failed',
}

/** Convert kebab-case to Title Case. */
export function formatSkillName(name: string): string {
  return name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** Derive a 0-100 progress value from a skill config for ProgressRing display. */
export function deriveProgressValue(config: { current?: number | null; target?: number | null; unit?: string | null } | null): number | null {
  if (!config || config.current == null) return null
  const unit = config.unit?.toLowerCase() ?? ''
  if (unit === '%' || unit === 'percent') return config.current
  if (config.target != null && config.target > 0) return Math.min(100, (config.current / config.target) * 100)
  return null
}

/** Strip "goal-" prefix and capitalize for display. */
export function formatProcessName(name: string): string {
  return formatSkillName(name.replace(/^goal-/, ''))
}
