/**
 * DB layer for credential proxy resource resolution.
 *
 * Delegates to CredentialResolverService from @skill-networks/database.
 * Raw SQL has been extracted to the service class — this module is now a
 * thin adapter that wires the sql client to the service.
 */

import { getSqlClient } from '@skill-networks/database/client'
import { CredentialResolverService } from '@skill-networks/database'

export type { ResolvedCredential, CredentialConfig } from '@skill-networks/database'

function getService(): CredentialResolverService {
  return new CredentialResolverService(getSqlClient())
}

export async function closeDb(): Promise<void> {
  // Connection lifecycle is managed by getSqlClient() — nothing to close here.
}

/**
 * Resolve the credential spec for a named resource.
 */
export async function resolveCredentialForResource(
  resourceName: string
): Promise<import('@skill-networks/database').ResolvedCredential | null> {
  return getService().resolveByName(resourceName)
}

/**
 * Find a resource whose config.urls contains the given hostname.
 * Used for URL-fallback routing when no X-Resource header is present.
 */
export async function resolveCredentialByHostname(
  hostname: string
): Promise<import('@skill-networks/database').ResolvedCredential | null> {
  return getService().resolveByHostname(hostname)
}
