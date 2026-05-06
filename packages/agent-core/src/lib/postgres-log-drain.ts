import type { DrainAdapter, LogEntry } from '@skill-networks/logger'
import { registerDrain } from '@skill-networks/logger'
import { LogsService } from '@skill-networks/database/services'
import { getSqlClient } from '@skill-networks/database/client'

export class PostgresLogDrain implements DrainAdapter {
  constructor(private logsService: LogsService) {}

  async write(entry: LogEntry): Promise<void> {
    try {
      await this.logsService.writeLog({
        level: entry.level,
        service: entry.service,
        message: entry.message,
        timestamp: entry.timestamp instanceof Date ? entry.timestamp.toISOString() : String(entry.timestamp),
        data: entry.data ?? null,
        error: entry.error ?? null,
      })
    } catch (err) {
      process.stderr.write(`[PostgresLogDrain] Failed: ${String(err)}\n`)
    }
  }
}

export function setupPostgresLogger(): void {
  registerDrain(new PostgresLogDrain(new LogsService(getSqlClient())))
}
