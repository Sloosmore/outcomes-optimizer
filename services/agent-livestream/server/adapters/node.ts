import { serve } from '@hono/node-server'
import { registerDrain, DatabaseDrain } from '@skill-networks/logger'
import { getDb, isDatabaseEnabled } from '@skill-networks/database/drizzle'
import { logs } from '@skill-networks/database/schema'
import app from '../app.js'

// Prevent unhandled rejections from the Claude Code SDK from crashing the server.
process.on('unhandledRejection', (reason) => {
  console.error('[BFF] unhandled rejection (non-fatal):', reason instanceof Error ? reason.message : String(reason))
})

if (process.env['DATABASE_URL']) {
  registerDrain(new DatabaseDrain({ getDb, isDatabaseEnabled, logsTable: logs }))
}

serve({ fetch: app.fetch, port: parseInt(process.env['PORT'] ?? '3001'), hostname: '0.0.0.0' }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`)
})
