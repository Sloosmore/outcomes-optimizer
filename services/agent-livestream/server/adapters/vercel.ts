import { handle } from 'hono/vercel'
import { registerDrain } from '@skill-networks/logger'
import { getSqlClient } from '@skill-networks/database/client'
import { LogsService } from '@skill-networks/database/services'
import type { DrainAdapter, LogEntry } from '@skill-networks/logger'
import app from '../app.js'

// Note: server/voice-agent.ts hardcodes localhost:3001 and is Node-only.
// It is out of scope for this serverless adapter. Do not add it here.

// Register log drain using the compiled postgres.js client (not Drizzle, which requires tsx).
// SKILL_NETWORKS_DATABASE_URL must point to the Supabase pooler (port 6543), not direct
// Postgres (port 5432), to avoid connection exhaustion across serverless function instances.
try {
  if (process.env['SKILL_NETWORKS_DATABASE_URL']) {
    const logsService = new LogsService(getSqlClient())
    const drain: DrainAdapter = {
      async write(entry: LogEntry): Promise<void> {
        try {
          await logsService.writeLog({
            level: entry.level,
            service: entry.service,
            message: entry.message,
            timestamp: entry.timestamp instanceof Date ? entry.timestamp.toISOString() : String(entry.timestamp),
            data: entry.data ?? null,
            error: entry.error ?? null,
          })
        } catch (err) {
          process.stderr.write(`[VercelLogDrain] Failed: ${String(err)}\n`)
        }
      }
    }
    registerDrain(drain)
  }
} catch (err) {
  process.stderr.write(`[VercelLogDrain] Init failed: ${String(err)}\n`)
}

export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
