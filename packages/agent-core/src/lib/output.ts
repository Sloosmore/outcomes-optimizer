/**
 * Standardized output helpers for agent-first CLI contracts.
 *
 * Exit codes:
 *   0 = success
 *   1 = usage error (bad args, missing required options, invalid UUID format)
 *   2 = runtime error (DB connection failure, timeout, unexpected error)
 *   3 = auth error (JWT expired/invalid, no credentials found)
 *   4 = not found (resource/process not found by name or ID)
 */

export function classifyExitCode(err: unknown): number {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (
    msg.includes('authentication') ||
    msg.includes('authorization') ||
    msg.includes('unauthorized') ||
    msg.includes('not authenticated') ||
    msg.includes('jwt expired') ||
    msg.includes('jwt invalid') ||
    msg.includes('token expired') ||
    msg.includes('invalid token') ||
    msg.includes('access token')
  ) {
    return 3
  }
  if (msg.includes('not found') || msg.includes('no rows') || msg.includes('not_found')) {
    return 4
  }
  return 2
}

export function outputError(opts: {
  code: string
  message: string
  retry?: boolean
  exitCode?: number
}): never {
  const exitCode = opts.exitCode ?? 2
  process.stderr.write(JSON.stringify({
    ok: false,
    error: { code: opts.code, message: opts.message, retry: opts.retry ?? false },
  }) + '\n')
  process.exit(exitCode)
}

export function outputJson(data: unknown): void {
  console.log(JSON.stringify({ ok: true, data }, null, 2))
}

export function outputJsonMerged(data: Record<string, unknown>): void {
  // Inject ok:true into existing object for backward compat
  console.log(JSON.stringify({ ok: true, ...data }, null, 2))
}
