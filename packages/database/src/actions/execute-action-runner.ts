/**
 * CLI runner for executeAction — invoked by agent-core's `action execute` command.
 * Usage: tsx execute-action-runner.ts <actionName> <jsonInput>
 *
 * Reads SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_KEY / SUPABASE_SERVICE_KEY /
 * SUPABASE_SERVICE_ROLE_KEY) from the environment, calls executeAction, and prints
 * the result as JSON to stdout. Exits with code 1 on failure.
 */
import { createClient } from '@supabase/supabase-js'
import { executeAction } from './execute-action.js'
import { getSupabaseUrl } from '../constants.js'

const [,, actionName, jsonInput] = process.argv

if (!actionName || !jsonInput) {
  console.error('Usage: tsx execute-action-runner.ts <actionName> <jsonInput>')
  process.exit(1)
}

let input: Record<string, unknown>
try {
  input = JSON.parse(jsonInput) as Record<string, unknown>
} catch {
  console.error(`Invalid JSON input: ${jsonInput}`)
  process.exit(1)
}

const url = getSupabaseUrl()
// Prefer service role key for full access (audit writes, RLS bypass).
// Fall back to anon key for lightweight usage.
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.SUPABASE_KEY

if (!key) {
  console.error(
    'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY / SUPABASE_KEY) environment variable is not set'
  )
  process.exit(1)
}

// Ensure service role key is also available as SUPABASE_SERVICE_ROLE_KEY for audit writes
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SERVICE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY
}

const client = createClient(url, key)

try {
  const result = await executeAction(actionName, input, client)
  console.log(JSON.stringify(result))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
