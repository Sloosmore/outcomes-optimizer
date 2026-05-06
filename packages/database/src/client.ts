/**
 * SQL client factory for packages/database service classes.
 * Uses postgres.js (not drizzle) — this is the raw query client used by the service classes.
 *
 * Connection resolution (in order):
 * 1. SKILL_NETWORKS_DATABASE_URL env var (direct Postgres — server/CI)
 * 2. DATABASE_URL env var (common alias)
 * 3. Supavisor JWT auth — constructs a pooled connection using the user's JWT from
 *    ~/.config/duoidal/token.json. RLS applies per-user. No direct Postgres password needed.
 *
 * For drizzle re-exports (getDb, isDatabaseEnabled, closeDb), import from
 * '@skill-networks/database/drizzle' instead. Those are only usable in tsx contexts.
 */
import diagnostics_channel from 'node:diagnostics_channel'
import postgres from 'postgres'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SUPAVISOR_HOST = process.env['SUPAVISOR_HOST'] || 'aws-0-us-east-1.pooler.supabase.com'

let _sql: ReturnType<typeof postgres> | undefined

export function getSqlClient(): ReturnType<typeof postgres> {
  const ch = diagnostics_channel.channel('skill-networks:db')
  const start = Date.now()
  if (ch.hasSubscribers) {
    try { ch.publish({ span: 'getSqlClient', phase: 'entry', duration_ms: 0, status: 'ok' }) } catch {}
  }
  try {
    if (!_sql) {
      const url = resolveConnectionUrl()
      const _rawTimeout = parseInt(process.env.DUOIDAL_TIMEOUT || '30000', 10)
      const timeoutMs = Number.isFinite(_rawTimeout) && _rawTimeout > 0 ? _rawTimeout : 30000
      _sql = postgres(url, {
        prepare: false, // Required for Supavisor pooler (transaction mode, port 6543)
        ssl: 'require',
        connect_timeout: Math.ceil(timeoutMs / 1000), // postgres.js uses seconds (integer)
        connection: {
          statement_timeout: timeoutMs, // milliseconds
        },
      })
    }
    if (ch.hasSubscribers) {
      try { ch.publish({ span: 'getSqlClient', phase: 'exit', duration_ms: Date.now() - start, status: 'ok' }) } catch {}
    }
    return _sql
  } catch (err) {
    if (ch.hasSubscribers) {
      try { ch.publish({ span: 'getSqlClient', phase: 'exit', duration_ms: Date.now() - start, status: 'error', error: err instanceof Error ? err.message : String(err) }) } catch {}
    }
    throw err
  }
}

export type Sql = ReturnType<typeof getSqlClient>

function resolveConnectionUrl(): string {
  // Priority 1: explicit env var (CI / server / direct Postgres)
  const explicit = process.env['SKILL_NETWORKS_DATABASE_URL'] || process.env['DATABASE_URL']
  if (explicit) return explicit

  // Priority 2: Supavisor JWT auth (local CLI usage)
  const jwt = readLocalJwt()
  if (jwt) {
    const projectRef = process.env['SUPABASE_PROJECT_REF']
    if (!projectRef) {
      throw new Error(
        'SUPABASE_PROJECT_REF must be set to use Supavisor JWT auth. Set SKILL_NETWORKS_DATABASE_URL/DATABASE_URL to bypass.'
      )
    }
    if (process.env.DUOIDAL_DEBUG) {
      process.stderr.write(JSON.stringify({ level: 'warn', code: 'DB_JWT_AUTH', message: '[database] No DATABASE_URL — using Supavisor JWT auth (RLS enforced)' }) + '\n')
    }
    return `postgresql://authenticated.${projectRef}:${encodeURIComponent(jwt)}@${SUPAVISOR_HOST}:6543/postgres`
  }

  throw new Error(
    'No database connection available. Either set SKILL_NETWORKS_DATABASE_URL or run: duoidal auth login'
  )
}

function readLocalJwt(): string | null {
  try {
    const tokenPath = path.join(os.homedir(), '.config', 'duoidal', 'token.json')
    const raw = fs.readFileSync(tokenPath, 'utf-8')
    const token = JSON.parse(raw)
    if (!token.access_token || typeof token.access_token !== 'string') {
      return null
    }
    // Check JWT expiry — warn and return null if expired so the user knows to re-authenticate
    const parts = token.access_token.split('.')
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
      if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
        if (process.env.DUOIDAL_DEBUG) {
          process.stderr.write(JSON.stringify({ level: 'warn', code: 'DB_JWT_EXPIRED', message: '[database] JWT at ~/.config/duoidal/token.json is expired — re-authenticate with: duoidal auth login' }) + '\n')
        }
        return null
      }
    }
    return token.access_token
  } catch {
    return null
  }
}

export async function closeSqlClient(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 1 }) // 1 second grace period, then force-terminate
    _sql = undefined
  }
}
