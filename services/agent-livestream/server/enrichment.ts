import { createLogger } from '@skill-networks/logger'
import type { MetricsService } from '@skill-networks/database/services'

const logger = createLogger('bff:enrichment')
const NINETY_DAYS_AGO_MS = 90 * 24 * 60 * 60 * 1000

type ResourceRow = Record<string, unknown> & {
  id: string
  type: string
  config: Record<string, unknown>
}

/**
 * Fetch metric_snapshots for a group of resources and assign `history`/`current`
 * into each resource's config in place. `metricKeyOf` extracts the metric key
 * from each resource's config (e.g. `r.config.metric` or `r.config.goal_metric`).
 */
async function fetchAndAssignMetrics(
  metrics: MetricsService,
  resources: ResourceRow[],
  metricKeyOf: (r: ResourceRow) => string,
  ninetyDaysAgo: string,
): Promise<void> {
  const ids = resources.map((r) => r.id)
  const metricKeys = [...new Set(resources.map(metricKeyOf))]
  const expectedKey = new Map(resources.map((r) => [r.id, metricKeyOf(r)]))
  const data = await metrics.getHistoryBatch(ids, metricKeys, ninetyDaysAgo)

  // Group by id → date, keeping the last snapshot per day (data is ordered ascending)
  const byId = new Map<string, Map<string, number>>()
  for (const row of data) {
    if (row.metric_key !== expectedKey.get(row.skill_id)) continue
    const date = new Date(row.measured_at).toISOString().slice(0, 10)
    const daily = byId.get(row.skill_id) ?? new Map<string, number>()
    daily.set(date, Number(row.value))
    byId.set(row.skill_id, daily)
  }

  for (const r of resources) {
    const daily = byId.get(r.id)
    if (!daily?.size) continue
    const entries = [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value }))
    r.config.history = entries
    r.config.current = entries[entries.length - 1].value
  }
}

/**
 * Enrich skill resources with live metric data from metric_snapshots.
 * Injects `current` (latest value) and `history` (time-series) into each
 * skill's config when the skill has a `config.metric` key.
 *
 * Mutates resources in place — no return value.
 */
export async function enrichWithMetrics(
  metrics: MetricsService,
  resources: ResourceRow[],
): Promise<void> {
  const skillsWithMetrics = resources.filter(
    (r) => r.type === 'skill' && typeof r.config?.metric === 'string' && typeof r.config?.formula !== 'string',
  )
  const agentsWithGoalMetric = resources.filter(
    (r) => r.type === 'agent' && typeof r.config?.goal_metric === 'string',
  )
  if (skillsWithMetrics.length === 0 && agentsWithGoalMetric.length === 0) return

  const ninetyDaysAgo = new Date(Date.now() - NINETY_DAYS_AGO_MS).toISOString()

  await Promise.all([
    skillsWithMetrics.length > 0
      ? fetchAndAssignMetrics(metrics, skillsWithMetrics, (r) => r.config.metric as string, ninetyDaysAgo)
      : Promise.resolve(),
    agentsWithGoalMetric.length > 0
      ? fetchAndAssignMetrics(metrics, agentsWithGoalMetric, (r) => r.config.goal_metric as string, ninetyDaysAgo)
      : Promise.resolve(),
  ])
}

export function enrichFormulaResources(
  resources: ResourceRow[],
): void {
  const formulaResources = resources.filter((r) => typeof r.config?.formula === 'string')
  if (formulaResources.length === 0) return

  // Build metric_key → date → value from already-enriched skill/agent resources.
  // Using in-memory history (populated by enrichWithMetrics, which must run first) ensures
  // formula evaluation only uses canonical per-skill snapshots, not unfiltered cross-skill
  // data that can contaminate the byDate map when multiple skills share a metric key.
  const byKey = new Map<string, Map<string, number>>()
  for (const r of resources) {
    // Skills use config.metric; agents use config.goal_metric — both can serve as formula deps
    const metricKey = (r.config?.metric ?? r.config?.goal_metric) as string | undefined
    if (typeof metricKey !== 'string' || typeof r.config?.formula === 'string') continue
    const history = r.config.history as { date: string; value: number }[] | undefined
    if (!history?.length) continue
    const dateMap = new Map<string, number>()
    for (const { date, value } of history) dateMap.set(date, value)
    byKey.set(metricKey, dateMap)
  }

  // Collect all dates that appear in any dep metric's history
  const allDates = new Set<string>()
  for (const dateMap of byKey.values()) {
    for (const date of dateMap.keys()) allDates.add(date)
  }
  const sortedDates = [...allDates].sort()

  // For each formula resource, iterate dates and evaluate the formula
  for (const r of formulaResources) {
    try {
      const formula = r.config.formula as string
      // Formula length is capped to prevent DoS via deeply nested expressions.
      if (formula.length > 500) {
        r.config.history = []
        r.config.current = null
        continue
      }
      const depKeys = formula.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []
      const entries: { date: string; value: number }[] = []

      for (const date of sortedDates) {
        // Check all dep keys are present and > 0 in the canonical skill's history
        let valid = true
        for (const key of depKeys) {
          const val = byKey.get(key)?.get(date)
          if (val === undefined || val <= 0) {
            valid = false
            break
          }
        }
        if (!valid) continue

        // Substitute each identifier with its numeric value.
        // depKeys are extracted via /[a-zA-Z_][a-zA-Z0-9_]*/g so they are
        // word-characters only and safe to interpolate into RegExp patterns.
        let numericExpr = formula
        for (const key of depKeys) {
          numericExpr = numericExpr.replace(
            new RegExp(`\\b${key}\\b`, 'g'),
            String(byKey.get(key)!.get(date)),
          )
        }

        // Safe-eval: validate the substituted string contains only numeric operators.
        // ^ (XOR) is intentionally excluded — formulas use ** for exponentiation.
        if (!/^[\d\s+\-*/.()eE%]+$/.test(numericExpr)) {
          continue
        }

        const value = new Function('return ' + numericExpr)() as number
        if (!Number.isFinite(value)) continue
        entries.push({ date, value })
      }

      r.config.history = entries
      r.config.current = entries.length > 0 ? entries[entries.length - 1].value : null
    } catch (err) {
      logger.error('error processing formula resource', { resourceId: r.id, err })
      r.config.history = []
    }
  }
}
