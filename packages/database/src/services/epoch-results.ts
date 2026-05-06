import type postgres from 'postgres'

type Sql = ReturnType<typeof postgres>

export interface EpochUpsertData {
  status: string
  cost?: number | null
  durationMs?: number | null
  sessionId?: string | null
  workflowRunId?: string | null
  stateSnapshot?: unknown
  startedAt?: Date | string | null
  completedAt?: Date | string | null
}

export interface EpochRow {
  id: string
  campaign_id: string
  epoch_number: number
  status: string
  cost: number | null
  duration_ms: number | null
  session_id: string | null
  workflow_run_id: string | null
  state_snapshot: unknown
  started_at: Date | null
  completed_at: Date | null
}

export class EpochResultsService {
  constructor(private sql: Sql) {}

  async upsert(processId: string, epochNumber: number, data: EpochUpsertData): Promise<void> {
    // Use object directly — postgres.js serializes to JSONB natively.
    // JSON.stringify + ::jsonb causes double-encoding (stores as JSON string type, not object).
    const stateSnapshot = data.stateSnapshot !== undefined && data.stateSnapshot !== null
      ? (data.stateSnapshot as Record<string, unknown>)
      : null

    const startedAt =
      data.startedAt instanceof Date
        ? data.startedAt
        : typeof data.startedAt === 'string'
          ? new Date(data.startedAt)
          : null

    const completedAt =
      data.completedAt instanceof Date
        ? data.completedAt
        : typeof data.completedAt === 'string'
          ? new Date(data.completedAt)
          : null

    const cost = data.cost ?? null
    const durationMs = data.durationMs ?? null
    const sessionId = data.sessionId ?? null
    const workflowRunId = data.workflowRunId ?? null

    await this.sql`
      INSERT INTO epoch_results (campaign_id, epoch_number, status, state_snapshot, started_at, completed_at, cost, duration_ms, session_id, workflow_run_id)
      VALUES (${processId}, ${epochNumber}, ${data.status}, ${stateSnapshot ? this.sql.json(stateSnapshot as unknown as import('postgres').JSONValue) : null}, ${startedAt}, ${completedAt}, ${cost}, ${durationMs}, ${sessionId}, ${workflowRunId})
      ON CONFLICT (campaign_id, epoch_number)
      DO UPDATE SET
        status = EXCLUDED.status,
        state_snapshot = COALESCE(EXCLUDED.state_snapshot, epoch_results.state_snapshot),
        started_at = COALESCE(epoch_results.started_at, EXCLUDED.started_at),
        completed_at = COALESCE(EXCLUDED.completed_at, epoch_results.completed_at),
        cost = COALESCE(EXCLUDED.cost, epoch_results.cost),
        duration_ms = COALESCE(EXCLUDED.duration_ms, epoch_results.duration_ms),
        session_id = COALESCE(EXCLUDED.session_id, epoch_results.session_id),
        workflow_run_id = COALESCE(EXCLUDED.workflow_run_id, epoch_results.workflow_run_id)
    `
  }

  async getByProcessId(processId: string, limit?: number): Promise<EpochRow[]> {
    if (limit !== undefined) {
      const rows: EpochRow[] = await this.sql`
        SELECT id, campaign_id, epoch_number, status, cost, duration_ms, session_id, workflow_run_id, state_snapshot, started_at, completed_at
        FROM epoch_results
        WHERE campaign_id = ${processId}
        ORDER BY epoch_number ASC
        LIMIT ${limit}
      `
      return rows
    }

    const rows: EpochRow[] = await this.sql`
      SELECT id, campaign_id, epoch_number, status, cost, duration_ms, session_id, workflow_run_id, state_snapshot, started_at, completed_at
      FROM epoch_results
      WHERE campaign_id = ${processId}
      ORDER BY epoch_number ASC
    `
    return rows
  }

  async getLatest(processId: string): Promise<EpochRow | null> {
    const rows: EpochRow[] = await this.sql`
      SELECT id, campaign_id, epoch_number, status, cost, duration_ms, session_id, workflow_run_id, state_snapshot, started_at, completed_at
      FROM epoch_results
      WHERE campaign_id = ${processId}
      ORDER BY epoch_number DESC
      LIMIT 1
    `
    return rows[0] ?? null
  }
}
