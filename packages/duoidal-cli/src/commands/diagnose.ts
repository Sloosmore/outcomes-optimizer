import { Command } from 'commander'
import fs from 'node:fs'

interface SpanEvent {
  span: string
  phase: string
  duration_ms: number
  status: string
  error?: string
  output?: Record<string, unknown>
  [key: string]: unknown
}

function getSuggestion(event: SpanEvent): string {
  const span = event.span ?? ''
  const error = event.error ?? ''
  const duration = event.duration_ms ?? 0

  if (event.status === 'error' || event.status === 'fail' || event.phase === 'timeout') {
    if (span.includes('getSqlClient') || span === 'health:db') {
      return 'getSqlClient timed out — check DATABASE_URL and network connectivity'
    }
    if (span.includes('initAdapter')) {
      return 'initAdapter timed out — check DATABASE_URL and network connectivity'
    }
    if (span.includes('resolveIdentity')) {
      return 'run: duoidal auth login'
    }
    if (span === 'health:jwt') {
      return 'JWT check failed — run: duoidal auth login'
    }
    if (span === 'health:scope') {
      return 'Scope check failed — check credentials and DB connectivity'
    }
    if (error.includes('DATABASE_URL') || error.includes('ECONNREFUSED') || error.includes('connect') || error.includes('timeout')) {
      return 'getSqlClient timed out — check DATABASE_URL and network connectivity'
    }
  }

  // Slow span checks
  if (span.includes('ProjectScopeService') && duration > 1000) {
    return 'scope resolution may be slow due to many projects'
  }
  if (span.includes('resolveUserProjects') && duration > 500) {
    return 'resolveUserProjects is slow — DB may be congested'
  }

  return 'Check trace for details — run with DUOIDAL_DEBUG=1 for verbose output'
}

export function diagnoseCommand(): Command {
  const cmd = new Command('diagnose')
  cmd.description('Analyze a trace file and suggest fixes')
  cmd.argument('<file>', 'Path to a .jsonl trace file')
  cmd.option('--json', 'Output JSON')
  cmd.action(async (file: string, opts: { json?: boolean }) => {
    const asJson = opts.json || !process.stdout.isTTY

    let lines: string[]
    try {
      const content = fs.readFileSync(file, 'utf-8')
      lines = content.trim().split('\n').filter(Boolean)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (asJson) {
        console.log(JSON.stringify({ error: `Cannot read file: ${error}` }, null, 2))
      } else {
        console.log(`Error reading file: ${error}`)
      }
      process.exit(1)
      return
    }

    const events: SpanEvent[] = []
    for (const line of lines) {
      try {
        events.push(JSON.parse(line))
      } catch {}
    }

    if (events.length === 0) {
      if (asJson) {
        console.log(JSON.stringify({ error: 'No events found in trace file' }, null, 2))
      } else {
        console.log('No events found in trace file')
      }
      process.exit(1)
      return
    }

    // Look for failed spans first (all phases — timeouts may be recorded as non-exit events)
    // Prefer specific spans over the generic 'command' wrapper span
    const allFailedSpans = events.filter(e => e.status === 'error' || e.status === 'fail' || e.phase === 'timeout')
    // Prioritize non-command spans (more specific failure info)
    const specificFailed = allFailedSpans.find(e => e.span !== 'command')
    const failedSpan = specificFailed ?? allFailedSpans[0] ?? null

    const exitEvents = events.filter(e => e.phase === 'exit')

    if (failedSpan) {
      const suggestion = getSuggestion(failedSpan)
      if (asJson) {
        console.log(JSON.stringify({ failed_span: failedSpan, suggestion }, null, 2))
      } else {
        console.log(`Failed span: ${failedSpan.span} (phase: ${failedSpan.phase}, ${failedSpan.duration_ms}ms)`)
        if (failedSpan.error) console.log(`Error: ${failedSpan.error}`)
        console.log(`Suggestion: ${suggestion}`)
      }
      process.exit(0)
      return
    }

    // No failed spans — find slowest span
    const slowestSpan = exitEvents.reduce<SpanEvent | null>((max, e) => {
      if (!max) return e
      return e.duration_ms > max.duration_ms ? e : max
    }, null)

    if (!slowestSpan) {
      if (asJson) {
        console.log(JSON.stringify({ error: 'No exit-phase events found' }, null, 2))
      } else {
        console.log('No exit-phase events found in trace file')
      }
      process.exit(0)
      return
    }

    const suggestion = getSuggestion(slowestSpan)
    if (asJson) {
      console.log(JSON.stringify({ slowest_span: slowestSpan, suggestion }, null, 2))
    } else {
      console.log(`Slowest span: ${slowestSpan.span} (phase: ${slowestSpan.phase}, ${slowestSpan.duration_ms}ms)`)
      console.log(`Suggestion: ${suggestion}`)
    }
    process.exit(0)
  })
  return cmd
}
