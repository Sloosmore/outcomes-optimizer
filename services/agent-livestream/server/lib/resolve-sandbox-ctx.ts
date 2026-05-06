import type { SupabaseClient } from '@supabase/supabase-js'
import { getServices } from './services.js'
import { resolveSshPrivateKey } from './resolve-ssh-key.js'

export interface SandboxCtx {
  host: string
  sandboxId: string
  privateKey: string
}

export type ResolveSandboxError =
  | 'user-not-found'
  | 'no-sandbox'
  | 'sandbox-ip-unavailable'
  | 'ssh-key-unavailable'

export interface ResolveSandboxResult {
  ctx?: SandboxCtx
  error?: ResolveSandboxError
}

/**
 * Resolve the SSH context for a user's first sandbox server resource.
 *
 * Lookup chain:
 *   1. user resource by auth_user_id
 *   2. parent links pointing to that user (server --[parent]--> user)
 *   3. first server-type resource among those parents
 *   4. host = config.ip
 *   5. private key from credential link (or SANDBOX_E2E_SSH_PRIVATE_KEY_B64 fallback)
 *
 * sandboxId is the server resource row id — that is what artifact-router and
 * tunnelHost lookups key off of.
 */
export async function resolveSandboxCtx(
  db: SupabaseClient,
  authUserId: string,
): Promise<ResolveSandboxResult> {
  const { resources } = getServices()

  const userResourceRef = await resources.findByExternalId('user', authUserId)
  if (!userResourceRef) return { error: 'user-not-found' }
  const userResource = await resources.getById(userResourceRef.id)
  if (!userResource) return { error: 'user-not-found' }

  const links = await resources.listLinksToId({ toId: userResource.id, linkType: 'parent' })
  if (!links || links.length === 0) return { error: 'no-sandbox' }

  const serverIds = links.map((l: { from_id: string }) => l.from_id)
  const serverResources = await resources.findByTypeAndIds('server', serverIds)
  const serverResource = serverResources[0] ?? null
  if (!serverResource) return { error: 'no-sandbox' }

  const serverConfig = serverResource.config as Record<string, unknown> | null
  const host = serverConfig?.['ip'] as string | undefined
  if (!host) return { error: 'sandbox-ip-unavailable' }

  const privateKey = await resolveSshPrivateKey(db, serverResource.id, authUserId)
  if (!privateKey) return { error: 'ssh-key-unavailable' }

  return {
    ctx: { host, sandboxId: serverResource.id, privateKey },
  }
}
