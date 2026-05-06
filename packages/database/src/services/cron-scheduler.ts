import type { Sql } from '../client.js'

export interface CronRow {
  id: string
  name: string
  config: { schedule: string; enabled: boolean; prompt?: string; bypass_idempotency?: boolean; depends_on?: string[] }
  created_at: Date
  skill_id: string
  skill_name: string
  skill_config: Record<string, unknown> | null
  skill_type: string
  type_prompt_prefix: string | null
  type_prompt_segments: Record<string, string> | null
}

export interface ICronSchedulerService {
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

export class CronSchedulerService implements ICronSchedulerService {
  constructor(private sql: Sql) {}

  async getCronsDue(): Promise<CronRow[]> {
    return this.sql<CronRow[]>`
      SELECT r.id, r.name, r.config, r.created_at,
        skill.id     AS skill_id,
        skill.name   AS skill_name,
        skill.config AS skill_config,
        skill.type   AS skill_type,
        rt.config_schema->>'system_prompt_prefix' AS type_prompt_prefix,
        rt.config_schema->'prompt_segments'       AS type_prompt_segments
      FROM resources r
      JOIN resource_links rl ON rl.from_id = r.id AND rl.link_type = 'schedules'
      JOIN resources skill ON skill.id = rl.to_id
      LEFT JOIN resource_types rt ON rt.name = skill.type
      WHERE r.type = 'cron' AND (r.config->>'enabled')::boolean = true
    `
  }

  async shouldDispatch(
    skillId: string,
    metricKey?: string,
    bypassIdempotency?: boolean,
    formulaResource?: boolean,
    maxFailuresPerDay?: number,
    formulaMetricKey?: string,
  ): Promise<{ skip: true; reason: string } | { skip: false }> {
    const sql = this.sql

    // If bypass flag is set, skip all idempotency gates
    if (bypassIdempotency === true) {
      return { skip: false }
    }

    // Gate 1: Check metric_snapshots (skip gate if no metricKey)
    if (metricKey !== undefined && formulaResource === true) {
      console.warn(`[poller] shouldDispatch: both metricKey and formulaResource set for skill ${skillId} — metricKey gate takes precedence`)
    }
    if (metricKey !== undefined) {
      const metricRows = await sql`
        SELECT 1 FROM metric_snapshots
        WHERE skill_id = ${skillId}
          AND metric_key = ${metricKey}
          AND measured_at >= date_trunc('day', NOW())
      `
      if (metricRows.length > 0) {
        return { skip: true, reason: `metric ${metricKey} already recorded today` }
      }
    } else if (formulaResource === true) {
      // For formula resources: check metric_snapshots if a formulaMetricKey is known,
      // otherwise fall back to checking for a completed process today.
      if (formulaMetricKey !== undefined) {
        const formulaMetricRows = await sql`
          SELECT 1 FROM metric_snapshots
          WHERE skill_id = ${skillId}
            AND metric_key = ${formulaMetricKey}
            AND measured_at >= date_trunc('day', NOW())
        `
        if (formulaMetricRows.length > 0) {
          return { skip: true, reason: `formula metric ${formulaMetricKey} already recorded today` }
        }
      } else {
        // check for completed process today
        const completedRows = await sql`
          SELECT 1 FROM processes
          WHERE skill_resource_id = ${skillId}
            AND status = 'completed'
            AND created_at >= date_trunc('day', NOW())
        `
        if (completedRows.length > 0) {
          return { skip: true, reason: 'process already completed today' }
        }
      }
    }

    // Gate 2: Check for active/pending processes
    const processRows = await sql`
      SELECT 1 FROM processes
      WHERE skill_resource_id = ${skillId}
        AND status IN ('active', 'pending')
        AND created_at >= date_trunc('day', NOW())
    `
    if (processRows.length > 0) {
      return { skip: true, reason: 'active process exists' }
    }

    // Gate 3: Stop after N total failures today with no success (configurable per skill, default 3)
    const failureLimit = maxFailuresPerDay ?? 3
    const failedRows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM processes
      WHERE skill_resource_id = ${skillId}
        AND status = 'failed'
        AND created_at >= date_trunc('day', NOW())
    `
    const failCount = failedRows[0]?.count ?? 0
    if (failCount >= failureLimit) {
      // Only gate if there's no completed process today — failures after a success are fine
      const completedToday = await sql`
        SELECT 1 FROM processes
        WHERE skill_resource_id = ${skillId}
          AND status = 'completed'
          AND created_at >= date_trunc('day', NOW())
      `
      if (completedToday.length === 0) {
        return { skip: true, reason: `${failCount} failures today with no success — halting until tomorrow` }
      }
    }

    return { skip: false }
  }

  async getMetricValue(skillId: string, metricKey: string): Promise<number | null> {
    const rows = await this.sql<{ value: number }[]>`
      SELECT value FROM metric_snapshots
      WHERE skill_id = ${skillId}
        AND metric_key = ${metricKey}
        AND measured_at >= date_trunc('day', NOW())
      ORDER BY measured_at DESC LIMIT 1
    `
    return rows[0]?.value ?? null
  }
}
