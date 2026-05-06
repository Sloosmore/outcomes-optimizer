import type postgres from 'postgres'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ReturnType<typeof postgres> | any

/** UUID v4 format check — validates proxyResourceId before querying. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Shape of the credential config stored on a credential-type resource. */
export interface CredentialConfig {
  dopplerProject: string
  envVars: string[]
}

/** Shape of a direct-value credential config (no Doppler needed). */
export interface DirectCredentialConfig {
  headerName: string
  headerValue: string
}

/** Resolved credential spec for a named resource. */
export interface ResolvedCredential {
  resourceName: string
  /** Hostnames/domain patterns this resource is authorized to send requests to. */
  urls: string[]
  /** Doppler project holding the secrets. */
  dopplerProject: string
  /** Env var names to fetch from Doppler. */
  envVars: string[]
  /**
   * How to inject the credential into the outbound request.
   * Defaults to "bearer" if not specified.
   */
  injectAs?: 'bearer' | 'header' | 'supabase' | 'query-param' | 'key-prefix' | 'oauth2-refresh' | 'oauth2-bearer'
  /** If injectAs === "header", the header name to use. */
  headerName?: string
  /** If injectAs === "query-param", the query parameter name to use (defaults to "key"). */
  paramName?: string
  /** If injectAs === "key-prefix", the prefix before the secret value (defaults to "Key"). */
  authPrefix?: string
  /** If injectAs === "oauth2-bearer", the token exchange endpoint (defaults to Google OAuth2). */
  tokenEndpoint?: string
  /**
   * Direct header value for credential injection without Doppler.
   * When present, the proxy injects this value directly without calling the secret store.
   */
  headerValue?: string
  /**
   * Env var name holding the SOCKS5 proxy URL for egress IP routing.
   * Present only if the identity resource has a proxyResourceId configured.
   */
  proxyUrlEnvVar?: string
  /** UUID of the resolved resource from the DB (resources.id). */
  resourceId: string
}

export interface ICredentialResolverService {
  resolveByName(resourceName: string): Promise<ResolvedCredential | null>
  resolveByHostname(hostname: string): Promise<ResolvedCredential | null>
}

export class CredentialResolverService implements ICredentialResolverService {
  constructor(private sql: Sql) {}

  /**
   * Resolve the credential spec for a named resource.
   *
   * Steps:
   *   1. SELECT resource WHERE name = resourceName
   *   2. Follow resource_links WHERE from_id = resource.id AND link_type = 'credential'
   *   3. SELECT the linked credential resource and extract its config
   *
   * Returns null if the resource is not found or has no credential link.
   */
  async resolveByName(resourceName: string): Promise<ResolvedCredential | null> {
    const sql = this.sql

    const resourceRows = await sql`
      SELECT id, name, type, config
      FROM resources
      WHERE name = ${resourceName}
        AND status = 'active'
      LIMIT 1
    ` as { id: string; name: string; type: string; config: Record<string, unknown> }[]

    if (resourceRows.length === 0) {
      return null
    }

    const resource = resourceRows[0]
    const resourceConfig = resource.config as Record<string, unknown>

    // Follow resource_links to find the credential resource.
    const linkRows = await sql`
      SELECT to_id
      FROM resource_links
      WHERE from_id = ${resource.id}
        AND link_type = 'credential'
      LIMIT 1
    ` as { to_id: string }[]

    let credentialConfig: Record<string, unknown>

    if (linkRows.length === 0) {
      // The resource itself may be a credential resource, or it may have
      // inline credential config (dopplerProject + envVars on its own config).
      if (
        typeof resourceConfig.dopplerProject === 'string' &&
        Array.isArray(resourceConfig.envVars)
      ) {
        credentialConfig = resourceConfig
      } else {
        return null
      }
    } else {
      // Fetch the linked credential resource.
      const credResourceRows = await sql`
        SELECT config
        FROM resources
        WHERE id = ${linkRows[0].to_id}
          AND status = 'active'
        LIMIT 1
      ` as { config: Record<string, unknown> }[]

      if (credResourceRows.length === 0) {
        return null
      }

      credentialConfig = credResourceRows[0].config as Record<string, unknown>
    }

    // Validate required fields.
    // Two valid shapes:
    //   (a) Doppler-backed: requires dopplerProject + envVars
    //   (b) Direct-value:   requires headerName + headerValue (no Doppler needed)
    const isDopplerBacked =
      typeof credentialConfig.dopplerProject === 'string' &&
      Array.isArray(credentialConfig.envVars)
    const isDirectValue =
      typeof credentialConfig.headerName === 'string' &&
      typeof credentialConfig.headerValue === 'string'

    if (!isDopplerBacked && !isDirectValue) {
      return null
    }

    const urls = Array.isArray(resourceConfig.urls)
      ? (resourceConfig.urls as string[])
      : []

    // Resolve proxy resource if proxyResourceId is set on the identity resource.
    let proxyUrlEnvVar: string | undefined
    const rawProxyId = resourceConfig.proxyResourceId
    if (typeof rawProxyId === 'string') {
      if (UUID_RE.test(rawProxyId)) {
        const proxyRows = await sql`
          SELECT config->>'urlEnvVar' as proxy_url_env_var
          FROM resources
          WHERE id = ${rawProxyId}::uuid
            AND status = 'active'
            AND type = 'proxy'
          LIMIT 1
        ` as { proxy_url_env_var: string }[]
        proxyUrlEnvVar = proxyRows[0]?.proxy_url_env_var ?? undefined
      }
    }

    return {
      resourceName,
      resourceId: resource.id,
      urls,
      dopplerProject: (credentialConfig.dopplerProject as string) ?? '',
      envVars: (credentialConfig.envVars as string[]) ?? [],
      injectAs:
        (credentialConfig.injectAs as 'bearer' | 'header' | 'supabase' | 'query-param' | 'key-prefix' | 'oauth2-refresh' | 'oauth2-bearer' | undefined) ??
        'bearer',
      headerName: credentialConfig.headerName as string | undefined,
      headerValue: credentialConfig.headerValue as string | undefined,
      paramName: credentialConfig.paramName as string | undefined,
      authPrefix: credentialConfig.authPrefix as string | undefined,
      tokenEndpoint: credentialConfig.tokenEndpoint as string | undefined,
      proxyUrlEnvVar,
    }
  }

  /**
   * Find a resource whose config.urls contains the given hostname.
   * Used for URL-fallback routing when no X-Resource header is present.
   */
  async resolveByHostname(hostname: string): Promise<ResolvedCredential | null> {
    // Normalize to lowercase before validation and DB lookup.
    // Hostnames are case-insensitive (RFC 1034 §3.1) but stored URLs are typically
    // lowercase. A case-sensitive jsonb @> check would miss a resource whose url
    // is stored as "api.example.com" when the request arrives as "API.Example.com".
    const normalized = hostname ? hostname.toLowerCase() : hostname
    if (!normalized || normalized.length > 253 || !/^[a-z0-9.\-]+$/.test(normalized)) {
      return null
    }

    const sql = this.sql

    // Find resources whose urls array includes this hostname.
    // Uses jsonb @> operator for containment check.
    // NOTE: Use sql.json([normalized]) rather than JSON.stringify([normalized])::jsonb —
    // postgres.js does not reliably cast string parameters to jsonb via ::cast syntax
    // when prepare:false is set (Supavisor transaction mode). sql.json() sends the
    // value with the correct JSONB type OID, avoiding the type mismatch.
    const resourceRows = await sql`
      SELECT id, name, config
      FROM resources
      WHERE status = 'active'
        AND config->'urls' @> ${sql.json([normalized])}
      LIMIT 1
    ` as { id: string; name: string; config: Record<string, unknown> }[]

    if (resourceRows.length === 0) {
      return null
    }

    // Let errors propagate — caller handles fallback to in-memory routes.
    return this.resolveByName(resourceRows[0].name)
  }
}
