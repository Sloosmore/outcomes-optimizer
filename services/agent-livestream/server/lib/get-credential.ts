import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:get-credential')

interface CredentialRow {
  credential_id: string
  secret: string
  metadata: unknown
}

/**
 * Retrieve a decrypted credential from Supabase Vault for the authenticated user.
 *
 * The RPC `get_user_credential` is SECURITY DEFINER and resolves the user's
 * identity from the JWT passed in the supabaseClient's session. It returns an
 * empty row set if the credential does not exist or is not owned by the caller —
 * this function converts that to a thrown error so callers can fail fast.
 *
 * @param supabaseClient - Authenticated Supabase client (carries the user's JWT)
 * @param credentialName - The credential's resource name or provider field value
 */
export async function getUserCredential(
  supabaseClient: SupabaseClient,
  credentialName: string,
): Promise<string> {
  const { data, error } = await supabaseClient.rpc('get_user_credential', {
    p_credential_name: credentialName,
  })

  if (error) {
    logger.error('get_user_credential RPC failed', { credentialName, error: error.message })
    throw new Error(`Failed to retrieve credential '${credentialName}': ${error.message}`)
  }

  const rows = data as CredentialRow[] | null
  if (!rows || rows.length === 0) {
    throw new Error(`Credential not found: '${credentialName}'`)
  }

  return rows[0].secret
}
