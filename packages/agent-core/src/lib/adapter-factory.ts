import diagnostics_channel from 'node:diagnostics_channel'
import type { OntologyStorageAdapter } from './ontology-adapter.js'
import { PostgresOntologyAdapter } from '../adapters/postgres-ontology-adapter.js'
import { getSqlClient } from '@skill-networks/database/client'
import { ResourcesService } from '@skill-networks/database'
import { ProjectScopeService } from '@skill-networks/database/services'
import { getSupabaseUrl, getSupabaseAnonKey } from '@skill-networks/database/constants'
import { parseJwtSub, parseJwtSubUnchecked, readLocalToken, writeLocalToken, isTokenExpired } from './identity.js'

let _adapter: OntologyStorageAdapter | null = null

export function getAdapter(): OntologyStorageAdapter {
  if (_adapter) return _adapter
  throw new Error('No adapter initialized — call initAdapter() first')
}

export function setAdapter(adapter: OntologyStorageAdapter): void {
  _adapter = adapter
}

export function clearAdapter(): void {
  _adapter = null
  _unscopedAdapter = null
}

let _unscopedAdapter: PostgresOntologyAdapter | null = null

/**
 * Admin escape hatch: returns an adapter with no project-scope filtering.
 * Use ONLY for operations that genuinely need system-wide access
 * (e.g., process init bootstrap, background metric recording).
 * The caller is responsible for authorization.
 * Greppable: getUnscopedAdapter()
 */
export function getUnscopedAdapter(): PostgresOntologyAdapter {
  if (!_unscopedAdapter) _unscopedAdapter = new PostgresOntologyAdapter()
  return _unscopedAdapter
}

export async function initAdapter(): Promise<void> {
  const _rawTimeout = parseInt(process.env.DUOIDAL_TIMEOUT || '30000', 10)
  const timeoutMs = Number.isFinite(_rawTimeout) && _rawTimeout > 0 ? _rawTimeout : 30000
  const startTime = Date.now()
  let phase = 'start'

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const duration = Date.now() - startTime
      const errorMessage = `TIMEOUT: initAdapter exceeded ${duration}ms during ${phase}`
      const dbCh = diagnostics_channel.channel('skill-networks:db')
      if (dbCh.hasSubscribers) {
        try { dbCh.publish({ span: 'initAdapter', phase: 'timeout', duration_ms: duration, status: 'error', error: errorMessage }) } catch {}
      }
      reject(new Error(errorMessage))
    }, timeoutMs)
  })

  const work = async (): Promise<void> => {
    phase = 'resolveIdentity'
    const sub = await resolveIdentity()
    phase = 'getSqlClient'
    const sql = getSqlClient()
    phase = 'getSqlClient/resolveUserProjects'
    const scopeCh = diagnostics_channel.channel('skill-networks:scope')
    const scopeStart = Date.now()
    if (scopeCh.hasSubscribers) {
      try { scopeCh.publish({ span: 'resolveUserProjects', phase: 'entry', duration_ms: 0, status: 'ok' }) } catch {}
    }
    const resources = new ResourcesService(sql)
    let authorizedProjects: Awaited<ReturnType<typeof resources.resolveUserProjects>>
    try {
      authorizedProjects = await resources.resolveUserProjects(sub)
      if (scopeCh.hasSubscribers) {
        try { scopeCh.publish({ span: 'resolveUserProjects', phase: 'exit', duration_ms: Date.now() - scopeStart, status: 'ok' }) } catch {}
      }
    } catch (err) {
      if (scopeCh.hasSubscribers) {
        try { scopeCh.publish({ span: 'resolveUserProjects', phase: 'exit', duration_ms: Date.now() - scopeStart, status: 'error', error: err instanceof Error ? err.message : String(err) }) } catch {}
      }
      throw err
    }
    phase = 'getSqlClient/ProjectScopeService.resolve'
    const resolveStart = Date.now()
    if (scopeCh.hasSubscribers) {
      try { scopeCh.publish({ span: 'ProjectScopeService.resolve', phase: 'entry', duration_ms: 0, status: 'ok' }) } catch {}
    }
    const scopeService = new ProjectScopeService(sql)
    let scope: Awaited<ReturnType<typeof scopeService.resolve>>
    try {
      scope = await scopeService.resolve({ roots: [...authorizedProjects] })
      if (scopeCh.hasSubscribers) {
        try { scopeCh.publish({ span: 'ProjectScopeService.resolve', phase: 'exit', duration_ms: Date.now() - resolveStart, status: 'ok' }) } catch {}
      }
    } catch (err) {
      if (scopeCh.hasSubscribers) {
        try { scopeCh.publish({ span: 'ProjectScopeService.resolve', phase: 'exit', duration_ms: Date.now() - resolveStart, status: 'error', error: err instanceof Error ? err.message : String(err) }) } catch {}
      }
      throw err
    }
    setAdapter(new PostgresOntologyAdapter({ scope }))
  }

  try {
    await Promise.race([work(), timeoutPromise])
  } finally {
    clearTimeout(timeoutHandle)
  }
}

async function resolveIdentity(): Promise<string> {
  const authCh = diagnostics_channel.channel('skill-networks:auth')
  const start = Date.now()
  if (authCh.hasSubscribers) {
    try { authCh.publish({ span: 'resolveIdentity', phase: 'entry', duration_ms: 0, status: 'ok' }) } catch {}
  }
  try {
    // DUOIDAL_TOKEN env var — check expiry (env tokens should be fresh)
    if (process.env.DUOIDAL_TOKEN) {
      const sub = parseJwtSub(process.env.DUOIDAL_TOKEN)
      if (sub) {
        if (authCh.hasSubscribers) {
          try { authCh.publish({ span: 'resolveIdentity', phase: 'exit', duration_ms: Date.now() - start, status: 'ok' }) } catch {}
        }
        return sub
      }
    }

    // Local token file
    const token = readLocalToken()
    if (token?.access_token) {
      // Fast path: token has ≥60s remaining — return immediately without refresh
      if (!isTokenExpired(token.access_token)) {
        const sub = parseJwtSub(token.access_token)
        if (sub) {
          if (authCh.hasSubscribers) {
            try { authCh.publish({ span: 'resolveIdentity', phase: 'exit', duration_ms: Date.now() - start, status: 'ok' }) } catch {}
          }
          return sub
        }
      }

      // Token expired or within 60s refresh buffer — attempt proactive refresh
      if (typeof token.refresh_token === 'string' && token.refresh_token) {
        const supabaseUrl = getSupabaseUrl()
        const supabaseAnonKey = getSupabaseAnonKey()

        try {
          const controller = new AbortController()
          const refreshTimeoutId = setTimeout(() => controller.abort(), 10_000)
          let resp: Response
          try {
            resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseAnonKey,
              },
              body: JSON.stringify({ refresh_token: token.refresh_token }),
              signal: controller.signal,
            })
          } finally {
            clearTimeout(refreshTimeoutId)
          }

          if (resp.ok) {
            const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
            if (data.access_token) {
              const refreshedSub = parseJwtSub(data.access_token)
              if (refreshedSub) {
                // Persist the refreshed token
                writeLocalToken({
                  access_token: data.access_token,
                  refresh_token: data.refresh_token ?? token.refresh_token,
                  expires_at: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
                })
                if (authCh.hasSubscribers) {
                  try { authCh.publish({ span: 'resolveIdentity', phase: 'exit', duration_ms: Date.now() - start, status: 'ok', output: { refreshed: true } }) } catch {}
                }
                return refreshedSub
              }
            }
          }
        } catch {
          // Refresh failed — fall through to unchecked sub extraction
        }
      }

      // Last resort: extract sub without expiry check. The sub is a stable
      // identifier for project scoping — the DB connection uses DATABASE_URL
      // or SUPABASE_SERVICE_KEY, not the JWT.
      const fallbackSub = parseJwtSubUnchecked(token.access_token)
      if (fallbackSub) {
        if (authCh.hasSubscribers) {
          try { authCh.publish({ span: 'resolveIdentity', phase: 'exit', duration_ms: Date.now() - start, status: 'ok', output: { expired_fallback: true } }) } catch {}
        }
        return fallbackSub
      }
    }

    if (authCh.hasSubscribers) {
      try { authCh.publish({ span: 'resolveIdentity', phase: 'exit', duration_ms: Date.now() - start, status: 'error', error: 'Not authenticated' }) } catch {}
    }
    console.error('Not authenticated. Run: duoidal auth login')
    process.exit(1)
    throw new Error('unreachable')
  } catch (err) {
    // Only publish if it's a real error (not process.exit)
    if (err instanceof Error && err.message !== 'unreachable') {
      if (authCh.hasSubscribers) {
        try { authCh.publish({ span: 'resolveIdentity', phase: 'exit', duration_ms: Date.now() - start, status: 'error', error: err.message }) } catch {}
      }
    }
    throw err
  }
}
