import { createClient } from '@supabase/supabase-js'
import { getSupabaseUrl, getSupabaseServiceKey } from '@skill-networks/database/constants'

// getSupabaseServiceKey() throws when unset; preserve the existing
// "log + exit(1)" boot-time contract by translating the throw to an exit.
let supabaseServiceKey: string
try {
  supabaseServiceKey = getSupabaseServiceKey()
} catch (err) {
  console.error('Missing required env var: SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY)', err)
  process.exit(1)
}

export const supabase = createClient(getSupabaseUrl(), supabaseServiceKey)
