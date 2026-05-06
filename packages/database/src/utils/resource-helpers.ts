/**
 * Pure helper functions and constants for the resources CLI.
 * Extracted so they can be imported by both resources.ts and tests.
 */

// NOTE: packages/agent-core/src/lib/resource-helpers.ts has the canonical VALID_TYPES list.
// This list must stay in sync with it. Future: load from resource_types table in DB.
export const VALID_TYPES = ['data', 'identity', 'url', 'credential', 'config', 'app', 'skill', 'proxy', 'server', 'database', 'deployment', 'bucket', 'cron'] as const
export const VALID_STATUSES = ['active', 'inactive', 'banned', 'expired', 'error'] as const

export function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const raw = arg.slice(2)
      const eqIndex = raw.indexOf('=')
      if (eqIndex !== -1) {
        // --flag=value syntax
        result[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1)
      } else {
        const value = args[i + 1]
        if (value && !value.startsWith('--')) {
          result[raw] = value
          i++
        } else {
          result[raw] = 'true'
        }
      }
    }
  }
  return result
}

export function parseJsonArg(raw: string, argName: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`--${argName} is not valid JSON: ${(e as SyntaxError).message}`)
  }
  if (parsed === null) {
    throw new Error(`--${argName} must be a JSON object, got null`)
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--${argName} must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
  }
  return parsed as Record<string, unknown>
}
