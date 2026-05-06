import type postgres from 'postgres'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ReturnType<typeof postgres> | any

export interface TraceRow {
  id: string
  session_id: string
  file_path: string | null
  cost: number | null
  duration_ms: number | null
  started_at: Date | null
  ended_at: Date | null
}

export interface ITracesService {
  getBySessionId(sessionId: string): Promise<TraceRow | null>
  upsert(values: {
    sessionId: string
    startedAt: string
    filePath: string
    cost?: number | null
    durationMs?: number | null
  }): Promise<{ id: string }>
}

export class TracesService implements ITracesService {
  constructor(private sql: Sql) {}

  async getBySessionId(sessionId: string): Promise<TraceRow | null> {
    const rows = await this.sql`
      SELECT id, session_id, file_path, cost, duration_ms, started_at, ended_at
      FROM traces
      WHERE session_id = ${sessionId}
      LIMIT 1
    `
    return (rows[0] as TraceRow) ?? null
  }

  async upsert(values: {
    sessionId: string
    startedAt: string
    filePath: string
    cost?: number | null
    durationMs?: number | null
  }): Promise<{ id: string }> {
    const sql = this.sql
    const rows = await sql`
      INSERT INTO traces (session_id, started_at, file_path, cost, duration_ms)
      VALUES (${values.sessionId}, ${values.startedAt}, ${values.filePath}, ${values.cost ?? null}, ${values.durationMs ?? null})
      ON CONFLICT (session_id) DO UPDATE SET
        file_path = EXCLUDED.file_path,
        cost = EXCLUDED.cost,
        duration_ms = EXCLUDED.duration_ms,
        ended_at = NOW()
      RETURNING id
    `
    return { id: (rows[0] as { id: string }).id }
  }
}
