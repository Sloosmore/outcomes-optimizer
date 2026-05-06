import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:ssh')

/**
 * Resolve SSH private key for a server resource.
 * Primary: vault lookup via get_user_credential_for RPC (link_type 'credential').
 * Fallback: SANDBOX_E2E_SSH_PRIVATE_KEY_B64 env var (base64-encoded key for E2E tests).
 * Returns null if neither source is available.
 */
export async function resolveSshPrivateKey(
  db: SupabaseClient,
  serverResourceId: string,
  authUserId: string,
): Promise<string | null> {
  const credResult = await db.rpc('get_user_credential_for', {
    p_resource_id: serverResourceId,
    p_link_type: 'credential',
    p_auth_uid: authUserId,
  })
  const credRows = credResult.data as Array<{ secret: string }> | null
  if (credRows && credRows.length > 0) return credRows[0].secret

  // Fallback: E2E test key stored as base64 env var
  const keyB64 = process.env['SANDBOX_E2E_SSH_PRIVATE_KEY_B64']
  if (keyB64) {
    logger.info('Using SANDBOX_E2E_SSH_PRIVATE_KEY_B64 fallback for SSH exec')
    return Buffer.from(keyB64, 'base64').toString('utf-8')
  }

  return null
}
