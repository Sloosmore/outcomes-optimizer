import { getSqlClient, type Sql } from '@skill-networks/database/client'
import { CronSchedulerService, type CronRow } from '@skill-networks/database/services'

// ── Types ────────────────────────────────────────────────────────────────────

export type { CronRow } from '@skill-networks/database/services'

// ── CronStore interface ───────────────────────────────────────────────────────

export interface CronStore {
  getCronsDue(): Promise<CronRow[]>
  shouldDispatch(
    skillId: string,
    metricKey?: string,
    bypassIdempotency?: boolean,
    formulaResource?: boolean,
    maxFailuresPerDay?: number,
    formulaMetricKey?: string,
  ): Promise<{ skip: true; reason: string } | { skip: false }>
  getMetricValue(skillId: string, metricKey: string): Promise<number | null>
}

// ── buildAgentPrompt ─────────────────────────────────────────────────────────

/**
 * Assembles the prompt for a resource. For agent-type resources with a
 * goal_metric, prepends the type_prompt_prefix and goal-metric block.
 * For all other resources, returns config.content unchanged.
 * Pure function — no DB access, no side effects.
 */
export function buildAgentPrompt(row: CronRow, metricValue: number | null): string {
  const config = row.skill_config
  const content = (config?.content as string | undefined) ?? ''

  // Only apply agent enrichment when skill_type is 'agent' AND goal_metric is set
  if (row.skill_type !== 'agent' || !config?.goal_metric) {
    return content
  }

  const goalMetric = config.goal_metric as string
  const targetValue = (config.target_value as string | undefined) ?? 'N/A'
  const targetDirection = (config.target_direction as string | undefined) ?? 'minimize'
  const targetSymbol = targetDirection === 'minimize' ? '≤' : '≥'
  const currentValue = metricValue !== null ? String(metricValue) : 'N/A'

  const prefix = row.type_prompt_prefix ?? ''
  let assembled = `${prefix}\n\nGoal metric: ${goalMetric}\nCurrent value: ${currentValue}\nTarget: ${targetSymbol} ${targetValue} (${targetDirection})\n\n${content}`

  // Append any prompt segments whose flag is enabled on the skill config
  for (const [flag, segment] of Object.entries(row.type_prompt_segments ?? {})) {
    if (config[flag] === true || config[flag] === 'true') {
      assembled += `\n\n${segment.replaceAll('{{goal_metric}}', goalMetric)}`
    }
  }

  return assembled
}

// ── createPostgresCronStore factory ──────────────────────────────────────────

export function createPostgresCronStore(sql: Sql): CronStore {
  return new CronSchedulerService(sql)
}

// ── Convenience standalone exports (sql-accepting wrappers around CronStore) ──

export async function getCronsDue(sql: Sql): Promise<CronRow[]> {
  return createPostgresCronStore(sql).getCronsDue()
}

export async function shouldDispatch(
  sql: Sql,
  skillId: string,
  metricKey?: string,
  bypassIdempotency?: boolean,
  formulaResource?: boolean,
  maxFailuresPerDay?: number,
  formulaMetricKey?: string,
): Promise<{ skip: true; reason: string } | { skip: false }> {
  return createPostgresCronStore(sql).shouldDispatch(skillId, metricKey, bypassIdempotency, formulaResource, maxFailuresPerDay, formulaMetricKey)
}

export async function getMetricValue(sql: Sql, skillId: string, metricKey: string): Promise<number | null> {
  return createPostgresCronStore(sql).getMetricValue(skillId, metricKey)
}
