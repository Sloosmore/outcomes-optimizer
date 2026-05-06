// Remote-log shim. The LiveKit Cloud worker container has no accessible
// stdout (lk agent logs only emits during build/deploy phases). This module
// fire-and-forget-POSTs structured boot/runtime events to the BFF's
// /api/debug-log endpoint, where Vercel logs capture them.
//
// Failures are swallowed — never let logging crash the worker.

import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:remote-log')
const BFF_URL = (process.env['BFF_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
const SECRET = process.env['RESEARCH_INTERNAL_SECRET']

let seq = 0

export function remoteLog(event: string, fields: Record<string, unknown> = {}): void {
  const payload = {
    seq: ++seq,
    event,
    pid: process.pid,
    workerId: process.env['LIVEKIT_AGENT_ID'] ?? null, // LK Cloud injects this
    ...fields,
  }
  // Also log locally in case stdout becomes accessible in the worker environment.
  logger.info('[remote-log]', payload)

  void fetch(`${BFF_URL}/api/debug-log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SECRET ? { 'X-Debug-Log-Secret': SECRET } : {}),
    },
    body: JSON.stringify(payload),
  }).catch(() => { /* never throw */ })
}
