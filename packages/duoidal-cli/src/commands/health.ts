import { Command } from 'commander'
import diagnostics_channel from 'node:diagnostics_channel'
import { getSqlClient } from '@skill-networks/database/client'
import { ResourcesService } from '@skill-networks/database'
import { ProjectScopeService } from '@skill-networks/database/services'
import { readLocalToken, parseJwtSub } from '@duoidal/agent-core'

interface CheckResult {
  name: string
  status: 'ok' | 'fail'
  duration_ms: number
  error?: string
  [key: string]: unknown
}

export function healthCommand(): Command {
  const cmd = new Command('health')
  cmd.description('Check all CLI dependencies (DB, JWT, scope resolution)')
  cmd.option('--json', 'Output JSON')
  cmd.action(async (opts: { json?: boolean }) => {
    const asJson = opts.json || !process.stdout.isTTY
    const checks: CheckResult[] = []

    // Read token once; reused by JWT and scope checks to avoid double disk read
    // and potential race between two reads if token file is refreshed mid-health-check.
    const localToken = readLocalToken()

    // Check 1: DB
    {
      const ch = diagnostics_channel.channel('skill-networks:db')
      const start = Date.now()
      if (ch.hasSubscribers) {
        try { ch.publish({ span: 'health:db', phase: 'entry', duration_ms: 0, status: 'ok' }) } catch {}
      }
      try {
        const sql = getSqlClient()
        await sql`SELECT 1`
        const duration_ms = Date.now() - start
        checks.push({ name: 'db', status: 'ok', duration_ms })
        if (ch.hasSubscribers) {
          try { ch.publish({ span: 'health:db', phase: 'exit', duration_ms, status: 'ok' }) } catch {}
        }
      } catch (err) {
        const duration_ms = Date.now() - start
        const error = err instanceof Error ? err.message : String(err)
        checks.push({ name: 'db', status: 'fail', duration_ms, error })
        if (ch.hasSubscribers) {
          try { ch.publish({ span: 'health:db', phase: 'exit', duration_ms, status: 'error', error }) } catch {}
        }
      }
    }

    // Check 2: JWT
    {
      const ch = diagnostics_channel.channel('skill-networks:auth')
      const start = Date.now()
      if (ch.hasSubscribers) {
        try { ch.publish({ span: 'health:jwt', phase: 'entry', duration_ms: 0, status: 'ok' }) } catch {}
      }
      try {
        const token = localToken
        if (!token?.access_token) throw new Error('No token found — run: duoidal auth login')
        // Check expiry
        const parts = token.access_token.split('.')
        if (parts.length >= 2) {
          const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
          if (typeof claims.exp === 'number') {
            const remaining = claims.exp - Math.floor(Date.now() / 1000)
            if (remaining <= 0) throw new Error('Token expired — run: duoidal auth login')
            const duration_ms = Date.now() - start
            checks.push({ name: 'jwt', status: 'ok', duration_ms, remaining_seconds: remaining })
            if (ch.hasSubscribers) {
              try { ch.publish({ span: 'health:jwt', phase: 'exit', duration_ms, status: 'ok', output: { remaining_seconds: remaining } }) } catch {}
            }
          } else {
            // No expiry claim — treat as valid
            const duration_ms = Date.now() - start
            checks.push({ name: 'jwt', status: 'ok', duration_ms })
            if (ch.hasSubscribers) {
              try { ch.publish({ span: 'health:jwt', phase: 'exit', duration_ms, status: 'ok' }) } catch {}
            }
          }
        } else {
          throw new Error('Malformed token')
        }
      } catch (err) {
        const duration_ms = Date.now() - start
        const error = err instanceof Error ? err.message : String(err)
        checks.push({ name: 'jwt', status: 'fail', duration_ms, error })
        if (ch.hasSubscribers) {
          try { ch.publish({ span: 'health:jwt', phase: 'exit', duration_ms, status: 'error', error }) } catch {}
        }
      }
    }

    // Check 3: Scope
    {
      const ch = diagnostics_channel.channel('skill-networks:scope')
      const start = Date.now()
      if (ch.hasSubscribers) {
        try { ch.publish({ span: 'health:scope', phase: 'entry', duration_ms: 0, status: 'ok' }) } catch {}
      }
      try {
        // Reuse the token read at the top of the health check to avoid a second disk read.
        const sub = localToken?.access_token ? parseJwtSub(localToken.access_token) : null
        if (!sub) throw new Error('No valid token for scope resolution')

        const sql = getSqlClient()
        const resources = new ResourcesService(sql)
        const projects = await resources.resolveUserProjects(sub)
        const scopeService = new ProjectScopeService(sql)
        const scope = await scopeService.resolve({ roots: [...projects] })
        const duration_ms = Date.now() - start
        checks.push({
          name: 'scope',
          status: 'ok',
          duration_ms,
          project_count: scope.projectIds.size,
          scope_size: scope.resourceIds.size,
        })
        if (ch.hasSubscribers) {
          try { ch.publish({ span: 'health:scope', phase: 'exit', duration_ms, status: 'ok', output: { project_count: scope.projectIds.size, scope_size: scope.resourceIds.size } }) } catch {}
        }
      } catch (err) {
        const duration_ms = Date.now() - start
        const error = err instanceof Error ? err.message : String(err)
        checks.push({ name: 'scope', status: 'fail', duration_ms, error })
        if (ch.hasSubscribers) {
          try { ch.publish({ span: 'health:scope', phase: 'exit', duration_ms, status: 'error', error }) } catch {}
        }
      }
    }

    const ok = checks.every(c => c.status === 'ok')

    if (asJson) {
      console.log(JSON.stringify({ ok, checks }, null, 2))
    } else {
      for (const c of checks) {
        const symbol = c.status === 'ok' ? '✓' : '✗'
        const extra: string[] = []
        if (c.remaining_seconds !== undefined) extra.push(`expires in ${c.remaining_seconds}s`)
        if (c.project_count !== undefined) extra.push(`${c.project_count} projects`)
        if (c.scope_size !== undefined) extra.push(`scope size ${c.scope_size}`)
        if (c.error) extra.push(c.error as string)
        const extraStr = extra.length ? ` — ${extra.join(', ')}` : ''
        console.log(`${symbol} ${c.name} (${c.duration_ms}ms)${extraStr}`)
      }
    }

    process.exit(ok ? 0 : 2)
  })
  return cmd
}
