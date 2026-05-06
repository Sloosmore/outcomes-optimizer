/**
 * CredentialStore — abstracts secret storage and retrieval.
 *
 * Implementations must cache aggressively: the proxy may receive many
 * concurrent requests and Doppler rate-limits service tokens.
 */
export interface CredentialStore {
  /**
   * Retrieve the value of a single secret.
   * Throws if the key is unknown or not in the proxy allowlist.
   */
  get(key: string): Promise<string>;

  /**
   * Invalidate all cached entries, forcing a fresh fetch on next access.
   */
  invalidate(): void;
}
