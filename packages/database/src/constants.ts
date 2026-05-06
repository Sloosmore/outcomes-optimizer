export const ENFORCE_PROJECT_SCOPING = true

// ── Supabase connection constants ─────────────────────────────────────────────

/** Reads the Supabase URL from env. Throws if unset. */
export function getSupabaseUrl(): string {
  const url = process.env['SUPABASE_URL']
  if (!url) throw new Error('SUPABASE_URL must be set')
  return url
}

/** Reads the Supabase anon key from env. Throws if unset. */
export function getSupabaseAnonKey(): string {
  const key = process.env['SUPABASE_ANON_KEY'] || process.env['VITE_SUPABASE_ANON_KEY']
  if (!key) throw new Error('SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY) must be set')
  return key
}

/** Reads the Supabase service role key from env. Throws if unset — this key grants
 *  elevated access and must never fall back to a hardcoded default. */
export function getSupabaseServiceKey(): string {
  const key = process.env['SUPABASE_SERVICE_KEY'] || process.env['SUPABASE_SERVICE_ROLE_KEY']
  if (!key) {
    throw new Error('SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set')
  }
  return key
}
