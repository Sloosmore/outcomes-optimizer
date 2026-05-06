/**
 * router.ts — credential resolution pipeline
 *
 * Given an outbound request (URL + optional X-Resource header), determines:
 *   1. Which resource is responsible (via X-Resource or URL-fallback hostname match)
 *   2. Whether the outbound hostname is in that resource's allowlist (CRITICAL security gate)
 *   3. Which credential to inject and how
 *
 * Security invariants enforced here:
 *   - Destination validation: credentials only injected when hostname is in resource.config.urls
 *   - X-Resource sanitization: strict [a-z0-9\-_] allowlist, max 128 chars
 *   - SSRF guard: resolved IP must not be RFC 1918 / link-local / loopback
 *   - Uniform error responses: all lookup failures are indistinguishable
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { getNativeFetch } from "./native-fetch.js";
import { createLogger } from "@skill-networks/logger";
import type { CredentialStore } from "./store/interface.js";
import {
  resolveCredentialForResource,
  resolveCredentialByHostname,
  type ResolvedCredential,
} from "./db.js";

const logger = createLogger('credential-proxy');

// ── Types ────────────────────────────────────────────────────────────────────

export interface RouteResult {
  /** Headers to inject into the outbound request. */
  injectHeaders: Record<string, string>;
  /** Query parameter to append to the target URL (for query-param injection mode). */
  queryParam?: { name: string; value: string };
  /** OAuth2 credentials to merge into the request body (for oauth2-refresh injection mode). */
  oauthCredentials?: { client_id: string; client_secret: string; refresh_token: string };
  /** The env var name holding the SOCKS5 proxy URL. Present if the resolved resource has a proxyResourceId. */
  proxyUrlEnvVar?: string;
  /** Resolved SOCKS5 proxy URL. Present only if proxyUrlEnvVar was set AND store.get() succeeded. */
  proxyUrl?: string;
  /** UUID of the resolved resource from the DB. Present only if a resource was resolved. */
  resourceId?: string;
}

export interface RouterConfig {
  store: CredentialStore;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Strict allowlist for X-Resource header values. */
const RESOURCE_NAME_RE = /^[a-z0-9\-_]{1,128}$/;

// ── OAuth2 Bearer token cache ─────────────────────────────────────────────────

interface CachedAccessToken {
  value: string;
  expiresAt: number;
}

/**
 * In-memory cache for access tokens obtained via oauth2-bearer exchange.
 * Keyed by resource name; tokens are re-fetched when they expire.
 * Access tokens typically last 1 hour (3600s); we refresh at 80% of lifetime.
 */
const accessTokenCache: Map<string, CachedAccessToken> = new Map();

/**
 * Exchange a refresh token for an access token via the Google OAuth2 token endpoint.
 * Returns the access_token string.
 */
async function exchangeRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  tokenEndpoint: string
): Promise<{ accessToken: string; expiresInMs: number }> {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  // Use native fetch to avoid routing through the interceptor.
  const nativeFetch = getNativeFetch();

  const response = await nativeFetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Token exchange response missing access_token");
  }

  // expires_in is in seconds; cache at 80% of lifetime (default 3600s → 2880s)
  const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
  const expiresInMs = Math.floor(expiresInSec * 0.8) * 1000;

  return { accessToken: data.access_token, expiresInMs };
}

/** RFC 1918 + link-local + loopback CIDR blocks that must never be proxied to. */
const BLOCKED_CIDRS: Array<{ base: bigint; mask: bigint }> = [
  // 127.0.0.0/8
  { base: ipv4ToBigInt("127.0.0.0"), mask: prefixToBigInt(8) },
  // 10.0.0.0/8
  { base: ipv4ToBigInt("10.0.0.0"), mask: prefixToBigInt(8) },
  // 172.16.0.0/12
  { base: ipv4ToBigInt("172.16.0.0"), mask: prefixToBigInt(12) },
  // 192.168.0.0/16
  { base: ipv4ToBigInt("192.168.0.0"), mask: prefixToBigInt(16) },
  // 169.254.0.0/16 (link-local)
  { base: ipv4ToBigInt("169.254.0.0"), mask: prefixToBigInt(16) },
  // 100.64.0.0/10 (CGNAT)
  { base: ipv4ToBigInt("100.64.0.0"), mask: prefixToBigInt(10) },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve credentials for an outbound request.
 *
 * Returns headers to inject, or an empty object if no credentials apply
 * (unknown resource, destination not in allowlist, SSRF blocked, etc.).
 *
 * Never throws — all errors are swallowed and result in no injection,
 * to prevent enumeration via timing or error content.
 */
export async function resolveCredentials(
  targetUrl: string,
  xResourceHeader: string | undefined,
  config: RouterConfig
): Promise<RouteResult> {
  try {
    const url = new URL(targetUrl);
    const hostname = url.hostname;

    // SSRF guard: block requests to private/loopback IPs.
    const ssrfBlocked = await isBlockedBySSRF(hostname);
    if (ssrfBlocked) {
      return { injectHeaders: {} };
    }

    // Sanitize X-Resource header.
    const resourceName = sanitizeResourceName(xResourceHeader);

    // Resolve the credential spec.
    let resolved: ResolvedCredential | null = null;

    if (resourceName) {
      // Named resource path.
      resolved = await resolveCredentialForResource(resourceName);
    } else {
      // URL-fallback path: match hostname against all resource config.urls.
      resolved = await resolveCredentialByHostname(hostname);
    }

    if (!resolved) {
      return { injectHeaders: {} };
    }

    const resourceId = resolved.resourceId;

    // CRITICAL security gate: destination hostname must be in resource's url allowlist.
    if (!isHostnameAllowed(hostname, resolved.urls)) {
      // Log internally but return nothing — prevents oracle.
      logger.warn('Destination not in allowlist — forwarding without credentials', { hostname, resourceName: resolved.resourceName });
      return { injectHeaders: {} };
    }

    // Resolve proxy URL if the resource has a proxyUrlEnvVar.
    // This is independent of credential injection — a resource may route through
    // a SOCKS5 proxy without injecting any credentials (e.g. instagram-squarebent).
    let proxyUrl: string | undefined;
    let proxyUrlEnvVar: string | undefined = resolved.proxyUrlEnvVar;
    if (resolved.proxyUrlEnvVar) {
      try {
        proxyUrl = await config.store.get(resolved.proxyUrlEnvVar);
      } catch {
        // Store rejected the key (not in allowlist) or key not found.
        // Return proxyUrl as undefined — handleProxy() will 502.
        proxyUrl = undefined;
      }
    }

    // For oauth2-bearer: exchange refresh_token for access_token and inject as Bearer.
    // envVars order: [0] = client_id, [1] = client_secret, [2] = refresh_token
    // Optional resolved.tokenEndpoint overrides the default Google endpoint.
    if (resolved.injectAs === "oauth2-bearer") {
      if (resolved.envVars.length < 3) {
        logger.warn('oauth2-bearer resource needs 3 envVars', { resourceName: resolved.resourceName, count: resolved.envVars.length });
        return { injectHeaders: {}, proxyUrlEnvVar, proxyUrl, resourceId };
      }
      const [clientIdVar, clientSecretVar, refreshTokenVar] = resolved.envVars;
      try {
        // Check cache first.
        const cached = accessTokenCache.get(resolved.resourceName);
        if (cached && cached.expiresAt > Date.now()) {
          return {
            injectHeaders: { Authorization: `Bearer ${cached.value}` },
            proxyUrlEnvVar,
            proxyUrl,
            resourceId,
          };
        }

        const [client_id, client_secret, refresh_token] = await Promise.all([
          config.store.get(clientIdVar),
          config.store.get(clientSecretVar),
          config.store.get(refreshTokenVar),
        ]);

        const tokenEndpoint = resolved.tokenEndpoint ?? "https://oauth2.googleapis.com/token";

        const { accessToken, expiresInMs } = await exchangeRefreshToken(
          client_id,
          client_secret,
          refresh_token,
          tokenEndpoint
        );

        accessTokenCache.set(resolved.resourceName, {
          value: accessToken,
          expiresAt: Date.now() + expiresInMs,
        });

        logger.info('oauth2-bearer: exchanged refresh_token for access_token', { resourceName: resolved.resourceName });

        return {
          injectHeaders: { Authorization: `Bearer ${accessToken}` },
          proxyUrlEnvVar,
          proxyUrl,
          resourceId,
        };
      } catch (err) {
        logger.error('Failed to exchange oauth2-bearer', err instanceof Error ? err : { error: String(err), resourceName: resolved.resourceName });
        return { injectHeaders: {}, proxyUrlEnvVar, proxyUrl, resourceId };
      }
    }

    // For oauth2-refresh, we need all 3 envVars in this fixed positional order:
    //   [0] = client_id var name
    //   [1] = client_secret var name
    //   [2] = refresh_token var name
    // This order is a contract enforced by the DB seed — do NOT reorder.
    if (resolved.injectAs === "oauth2-refresh") {
      if (resolved.envVars.length < 3) {
        logger.warn('oauth2-refresh resource needs 3 envVars', { resourceName: resolved.resourceName, count: resolved.envVars.length });
        return { injectHeaders: {}, proxyUrlEnvVar, proxyUrl, resourceId };
      }
      const [clientIdVar, clientSecretVar, refreshTokenVar] = resolved.envVars;
      try {
        const [client_id, client_secret, refresh_token] = await Promise.all([
          config.store.get(clientIdVar),
          config.store.get(clientSecretVar),
          config.store.get(refreshTokenVar),
        ]);
        return {
          injectHeaders: {},
          oauthCredentials: { client_id, client_secret, refresh_token },
          proxyUrlEnvVar,
          proxyUrl,
          resourceId,
        };
      } catch (err) {
        logger.error('Failed to fetch oauth2-refresh credentials', err instanceof Error ? err : { error: String(err), resourceName: resolved.resourceName });
        return { injectHeaders: {}, proxyUrlEnvVar, proxyUrl, resourceId };
      }
    }

    // If the credential config contains a direct headerValue, inject it without Doppler.
    if (resolved.headerValue && resolved.headerName) {
      return {
        injectHeaders: { [resolved.headerName]: resolved.headerValue },
        proxyUrlEnvVar,
        proxyUrl,
        resourceId,
      };
    }

    // Fetch the credential value.
    const envVarName = resolved.envVars[0];
    if (!envVarName) {
      // No credentials to inject, but proxy routing may still apply.
      return { injectHeaders: {}, proxyUrlEnvVar, proxyUrl, resourceId };
    }

    const secretValue = await config.store.get(envVarName);

    // Build injection headers (or query param for query-param mode).
    const injectHeaders: Record<string, string> = {};
    if (resolved.injectAs === "query-param") {
      const paramName = resolved.paramName ?? "key";
      return { injectHeaders: {}, queryParam: { name: paramName, value: secretValue }, proxyUrlEnvVar, proxyUrl, resourceId };
    } else if (resolved.injectAs === "header" && resolved.headerName) {
      injectHeaders[resolved.headerName] = secretValue;
    } else if (resolved.injectAs === "supabase") {
      // Supabase requires both Authorization: Bearer and apikey headers.
      injectHeaders["Authorization"] = `Bearer ${secretValue}`;
      injectHeaders["apikey"] = secretValue;
    } else if (resolved.injectAs === "key-prefix") {
      const prefix = resolved.authPrefix ?? "Key";
      injectHeaders["Authorization"] = `${prefix} ${secretValue}`;
    } else {
      // Default: Bearer token.
      injectHeaders["Authorization"] = `Bearer ${secretValue}`;
    }

    return { injectHeaders, proxyUrlEnvVar, proxyUrl, resourceId };
  } catch (err) {
    // Uniform error: return no credentials without leaking reason.
    // Log server-side so operators can diagnose DB/store failures.
    logger.error('Credential resolution failed', err instanceof Error ? err : { error: String(err) });
    return { injectHeaders: {} };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Sanitize and validate the X-Resource header value.
 * Returns null if absent or invalid (closes CRLF injection + path-traversal).
 */
function sanitizeResourceName(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!RESOURCE_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

/** Check if hostname (or a parent domain) is in the allowed URL list. */
function isHostnameAllowed(hostname: string, urls: string[]): boolean {
  // Normalize trailing dots (valid FQDN notation) to prevent mismatches.
  const lowerHostname = hostname.toLowerCase().replace(/\.$/, "");
  return urls.some((pattern) => {
    const lowerPattern = pattern.toLowerCase().replace(/\.$/, "");
    return (
      lowerHostname === lowerPattern ||
      lowerHostname.endsWith(`.${lowerPattern}`)
    );
  });
}

/**
 * SSRF guard: resolve the hostname to IPs and block private ranges.
 * Returns true if the hostname should be blocked.
 */
export async function isBlockedBySSRF(hostname: string): Promise<boolean> {
  // If hostname is a raw IP, check it directly.
  if (isIP(hostname)) {
    return isBlockedIP(hostname);
  }

  try {
    const { address: address4 } = await dns.lookup(hostname, { family: 4 }).catch(() => ({ address: null }));
    const { address: address6 } = await dns.lookup(hostname, { family: 6 }).catch(() => ({ address: null }));

    if (address4 && isBlockedIP(address4)) return true;
    if (address6 && isBlockedIPv6(address6)) return true;

    // If DNS failed for both families, block by default (fail-closed).
    if (!address4 && !address6) return true;

    return false;
  } catch {
    // If DNS fails, block by default.
    return true;
  }
}

function isBlockedIP(ip: string): boolean {
  try {
    const ipBig = ipv4ToBigInt(ip);
    return BLOCKED_CIDRS.some(({ base, mask }) => (ipBig & mask) === base);
  } catch {
    return true; // Malformed IP → block.
  }
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Loopback ::1
  if (lower === "::1") return true;

  // Link-local fe80::/10
  if (lower.startsWith("fe80:")) return true;

  // Unique local fc00::/7
  const fc = parseInt(lower.slice(0, 2), 16);
  if (!isNaN(fc) && (fc & 0xfe) === 0xfc) return true;

  // IPv4-mapped addresses ::ffff:x.x.x.x
  const v4MappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isBlockedIP(v4MappedMatch[1]);
  }

  return false;
}

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4: ${ip}`);
  }
  return BigInt(
    (parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!
  ) & BigInt(0xffffffff);
}

function prefixToBigInt(prefix: number): bigint {
  return BigInt(0xffffffff) << BigInt(32 - prefix) & BigInt(0xffffffff);
}
