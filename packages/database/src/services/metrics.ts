import type postgres from 'postgres'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ReturnType<typeof postgres> | any

const METRIC_KEY_RE = /^[a-zA-Z0-9_.-]{1,128}$/
const MEASURED_AT_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/
const METRIC_ELIGIBLE_TYPES = ['skill', 'agent'] as const

export interface MetricSnapshot {
  id: string
  skillId: string
  metricKey: string
  value: string  // postgres.js returns numeric as string
  measuredAt: string
  metadata: Record<string, unknown>
}

export interface RawMetricRow {
  metric_key: string
  value: string
  measured_at: string
  metadata: Record<string, unknown>
}

export interface RawMetricRowWithSkillId extends RawMetricRow {
  skill_id: string
}

export interface IMetricsService {
  record(skillId: string, metricKey: string, value: number, metadata?: Record<string, unknown>, measuredAt?: string): Promise<void>
  getLatest(skillId: string): Promise<MetricSnapshot[]>
  getHistory(skillId: string, metricKey: string, days: number): Promise<MetricSnapshot[]>
  getBySkillIds(skillIds: string[]): Promise<Map<string, MetricSnapshot[]>>
  getLatestSnapshots(skillId?: string): Promise<RawMetricRow[]>
  getHistoryWindow(skillId: string, key: string, cutoff: string): Promise<RawMetricRow[]>
  getHistoryBatch(skillIds: string[], metricKeys: string[], since: string): Promise<RawMetricRowWithSkillId[]>
  getHistoryByKeys(metricKeys: string[], since: string): Promise<RawMetricRow[]>
  latestByKey(key: string): Promise<MetricSnapshot[]>
  historyByKey(key: string, days: number): Promise<MetricSnapshot[]>
}

export class MetricsService implements IMetricsService {
  constructor(private sql: Sql) {}

  async record(
    skillId: string,
    metricKey: string,
    value: number,
    metadata?: Record<string, unknown>,
    measuredAt?: string,
  ): Promise<void> {
    if (!METRIC_KEY_RE.test(metricKey)) {
      throw new Error(`Invalid metric key: "${metricKey}". Must match [a-zA-Z0-9_.-]{1,128}`)
    }
    if (measuredAt !== undefined && !MEASURED_AT_RE.test(measuredAt)) {
      throw new Error(`Invalid measuredAt: "${measuredAt}". Must be ISO 8601 format`)
    }

    const sql = this.sql
    const rows = await sql`SELECT id, type FROM resources WHERE id = ${skillId}`
    const resource = rows[0] as { id: string; type: string } | undefined
    if (!resource) throw new Error(`Resource not found: ${skillId}`)
    // Allow both skill and agent types to record metrics — agents are first-class metric owners
    if (!(METRIC_ELIGIBLE_TYPES as readonly string[]).includes(resource.type)) {
      throw new Error(`Resource ${skillId} is not a skill or agent (type: ${resource.type})`)
    }

    if (measuredAt !== undefined) {
      await sql`
        INSERT INTO metric_snapshots (skill_id, metric_key, value, measured_at, metadata)
        VALUES (${skillId}, ${metricKey}, ${value}, ${measuredAt}, ${sql.json(metadata ?? {})})
        ON CONFLICT ON CONSTRAINT uq_metric_snapshots
        DO UPDATE SET value = EXCLUDED.value, metadata = EXCLUDED.metadata
      `
    } else {
      await sql`
        INSERT INTO metric_snapshots (skill_id, metric_key, value, metadata)
        VALUES (${skillId}, ${metricKey}, ${value}, ${sql.json(metadata ?? {})})
        ON CONFLICT ON CONSTRAINT uq_metric_snapshots
        DO UPDATE SET value = EXCLUDED.value, metadata = EXCLUDED.metadata
      `
    }
  }

  async getLatest(skillId: string): Promise<MetricSnapshot[]> {
    const rows = await this.sql`
      SELECT DISTINCT ON (metric_key) id, skill_id, metric_key, value, measured_at, metadata
      FROM metric_snapshots
      WHERE skill_id = ${skillId}
      ORDER BY metric_key, measured_at DESC
    `
    return (rows as Record<string, unknown>[]).map(row => ({
      id: row.id as string,
      skillId: row.skill_id as string,
      metricKey: row.metric_key as string,
      value: row.value as string,
      measuredAt: row.measured_at as string,
      metadata: row.metadata as Record<string, unknown>,
    }))
  }

  async getHistory(skillId: string, metricKey: string, days: number): Promise<MetricSnapshot[]> {
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error(`Invalid days: ${days}. Must be an integer between 1 and 3650`)
    }

    const sql = this.sql
    const rows = await sql`
      SELECT id, skill_id, metric_key, value, measured_at, metadata
      FROM metric_snapshots
      WHERE skill_id = ${skillId}
        AND metric_key = ${metricKey}
        AND measured_at >= NOW() - (${days} * INTERVAL '1 day')
      ORDER BY measured_at ASC
    `
    return (rows as Record<string, unknown>[]).map(row => ({
      id: row.id as string,
      skillId: row.skill_id as string,
      metricKey: row.metric_key as string,
      value: row.value as string,
      measuredAt: row.measured_at as string,
      metadata: row.metadata as Record<string, unknown>,
    }))
  }

  async getBySkillIds(skillIds: string[]): Promise<Map<string, MetricSnapshot[]>> {
    if (skillIds.length === 0) return new Map()

    const sql = this.sql
    const rows = await sql`
      SELECT DISTINCT ON (skill_id, metric_key) id, skill_id, metric_key, value, measured_at, metadata
      FROM metric_snapshots
      WHERE skill_id::text = ANY(${sql.array(skillIds)})
      ORDER BY skill_id, metric_key, measured_at DESC
    `

    const result = new Map<string, MetricSnapshot[]>()
    for (const row of rows as Record<string, unknown>[]) {
      const snapshot: MetricSnapshot = {
        id: row.id as string,
        skillId: row.skill_id as string,
        metricKey: row.metric_key as string,
        value: row.value as string,
        measuredAt: row.measured_at as string,
        metadata: row.metadata as Record<string, unknown>,
      }
      const existing = result.get(snapshot.skillId)
      if (existing) {
        existing.push(snapshot)
      } else {
        result.set(snapshot.skillId, [snapshot])
      }
    }
    return result
  }

  async getLatestSnapshots(skillId?: string): Promise<RawMetricRow[]> {
    const sql = this.sql
    let rows: Record<string, unknown>[]
    if (skillId) {
      rows = await sql`
        SELECT DISTINCT ON (metric_key) metric_key, value, measured_at, metadata
        FROM metric_snapshots
        WHERE skill_id = ${skillId}
        ORDER BY metric_key, measured_at DESC
      `
    } else {
      rows = await sql`
        SELECT DISTINCT ON (skill_id, metric_key) metric_key, value, measured_at, metadata
        FROM metric_snapshots
        ORDER BY skill_id, metric_key, measured_at DESC
        LIMIT 500
      `
    }
    return rows.map(row => ({
      ...row,
      measured_at: row['measured_at'] instanceof Date
        ? (row['measured_at'] as Date).toISOString()
        : (row['measured_at'] as string),
    })) as RawMetricRow[]
  }

  async getHistoryWindow(skillId: string, key: string, cutoff: string): Promise<RawMetricRow[]> {
    const sql = this.sql
    const rows = await sql`
      SELECT metric_key, value, measured_at, metadata
      FROM metric_snapshots
      WHERE skill_id = ${skillId}
        AND metric_key = ${key}
        AND measured_at >= ${cutoff}
      ORDER BY measured_at ASC
      LIMIT 5000
    `
    return rows as unknown as RawMetricRow[]
  }

  async getHistoryBatch(skillIds: string[], metricKeys: string[], since: string): Promise<RawMetricRowWithSkillId[]> {
    if (skillIds.length === 0 || metricKeys.length === 0) return []
    const sql = this.sql
    const rows = await sql`
      SELECT skill_id, metric_key, value, measured_at
      FROM metric_snapshots
      WHERE skill_id::text = ANY(${sql.array(skillIds)})
        AND metric_key = ANY(${sql.array(metricKeys)})
        AND measured_at >= ${since}
      ORDER BY measured_at ASC
    `
    return rows as unknown as RawMetricRowWithSkillId[]
  }

  async getHistoryByKeys(metricKeys: string[], since: string): Promise<RawMetricRow[]> {
    if (metricKeys.length === 0) return []
    const sql = this.sql
    const rows = await sql`
      SELECT metric_key, value, measured_at
      FROM metric_snapshots
      WHERE metric_key = ANY(${sql.array(metricKeys)})
        AND measured_at >= ${since}
      ORDER BY measured_at ASC
    `
    return rows as unknown as RawMetricRow[]
  }

  async latestByKey(key: string): Promise<MetricSnapshot[]> {
    const rows = await this.sql`
      SELECT DISTINCT ON (skill_id) id, skill_id, metric_key, value, measured_at, metadata
      FROM metric_snapshots
      WHERE metric_key = ${key}
      ORDER BY skill_id, measured_at DESC
    `
    return (rows as Record<string, unknown>[]).map(row => ({
      id: row.id as string,
      skillId: row.skill_id as string,
      metricKey: row.metric_key as string,
      value: row.value as string,
      measuredAt: row.measured_at as string,
      metadata: row.metadata as Record<string, unknown>,
    }))
  }

  async historyByKey(key: string, days: number): Promise<MetricSnapshot[]> {
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error(`Invalid days: ${days}. Must be an integer between 1 and 3650`)
    }

    const sql = this.sql
    const rows = await sql`
      SELECT id, skill_id, metric_key, value, measured_at, metadata
      FROM metric_snapshots
      WHERE metric_key = ${key}
        AND measured_at >= NOW() - (${days} * INTERVAL '1 day')
      ORDER BY measured_at ASC
    `
    return (rows as Record<string, unknown>[]).map(row => ({
      id: row.id as string,
      skillId: row.skill_id as string,
      metricKey: row.metric_key as string,
      value: row.value as string,
      measuredAt: row.measured_at as string,
      metadata: row.metadata as Record<string, unknown>,
    }))
  }
}
