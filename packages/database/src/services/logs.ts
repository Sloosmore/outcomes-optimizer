import type postgres from 'postgres'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ReturnType<typeof postgres> | any

export interface LogEntry {
  level: string
  service: string
  message: string
  timestamp: string
  data?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
}

export interface ILogsService {
  writeLog(entry: LogEntry): Promise<void>
}

export class LogsService implements ILogsService {
  constructor(private sql: Sql) {}

  async writeLog(entry: LogEntry): Promise<void> {
    const sql = this.sql
    await sql`
      INSERT INTO logs (level, service, message, timestamp, data, error)
      VALUES (
        ${entry.level},
        ${entry.service},
        ${entry.message},
        ${entry.timestamp},
        ${entry.data ? sql.json(entry.data) : null},
        ${entry.error ? sql.json(entry.error) : null}
      )
    `
  }
}
