/**
 * interceptor.ts — patches globalThis.fetch to route through the credential proxy.
 *
 * When installed, all fetch() calls from the agent process are transparently
 * rewritten to pass through the local proxy sidecar. The proxy injects credentials;
 * the agent process never sees raw secrets.
 *
 * Installation is idempotent: calling install() twice is a no-op.
 *
 * The X-Resource header may be set by the caller to hint which resource's
 * credentials to use. If absent, the proxy falls back to hostname-based routing.
 */

import { CREDENTIAL_PROXY_URL_ENV } from "./config.js";
import { createLogger } from "@skill-networks/logger";

const logger = createLogger("credential-proxy");

const DEFAULT_PROXY_URL = "http://127.0.0.1:7447";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hostnames that always bypass the credential proxy — they use their own
 * authentication and must never be rerouted through the sidecar.
 *
 * Extend via CREDENTIAL_PROXY_BYPASS_URLS (comma-separated base URLs) for
 * non-standard endpoints such as local AI gateways.
 */
const AI_PROVIDER_BYPASS_HOSTS = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com", // Google Gemini
  "api.mistral.ai",
  "api.together.xyz",
  "openrouter.ai",
]);

let _bypassBaseUrls: string[] | null = null;

/**
 * Returns the list of base URLs that should bypass the proxy, sourced from
 * ANTHROPIC_BASE_URL and CREDENTIAL_PROXY_BYPASS_URLS.
 *
 * Result is cached on first call and cleared when uninstallFetchInterceptor()
 * is called. Env vars must be set before the first proxied fetch() — changes
 * made after installation are not picked up until a reinstall.
 */
function getBypassBaseUrls(): string[] {
  if (_bypassBaseUrls !== null) return _bypassBaseUrls;
  // ANTHROPIC_BASE_URL — custom/local Anthropic gateway (e.g. http://172.18.0.1:8317)
  const anthropicBase = process.env.ANTHROPIC_BASE_URL;
  // CREDENTIAL_PROXY_BYPASS_URLS — additional comma-separated base URLs to skip
  const extra = (process.env.CREDENTIAL_PROXY_BYPASS_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  _bypassBaseUrls = [anthropicBase, ...extra].filter(Boolean) as string[];
  return _bypassBaseUrls;
}

function isAiProviderUrl(targetUrl: string, hostname: string): boolean {
  if (AI_PROVIDER_BYPASS_HOSTS.has(hostname)) return true;
  return getBypassBaseUrls().some((base) => {
    if (!targetUrl.startsWith(base)) return false;
    const next = targetUrl[base.length];
    return next === undefined || next === "/" || next === "?" || next === "#";
  });
}

let _installed = false;
let _originalFetch: typeof globalThis.fetch | null = null;

export function getProxyUrl(): string {
  return process.env[CREDENTIAL_PROXY_URL_ENV] ?? DEFAULT_PROXY_URL;
}

/**
 * Patch globalThis.fetch to route through the credential proxy.
 *
 * After installation, fetch() calls work identically from the caller's
 * perspective — but credentials are injected by the proxy sidecar without
 * ever appearing in this process's environment.
 */
export function installFetchInterceptor(): void {
  if (_installed) return;

  const proxyUrl = getProxyUrl();
  const originalFetch = globalThis.fetch;
  _originalFetch = originalFetch;

  // Expose the original fetch on globalThis so that code which must bypass the
  // interceptor (e.g. OAuth token exchanges that perform their own auth) can
  // access the unpatched implementation via `__nativeFetch`.
  (globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch = originalFetch;

  globalThis.fetch = async function proxiedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // Normalize the target URL.
    let targetUrl: string;
    let originalRequest: Request | null = null;

    if (input instanceof Request) {
      originalRequest = input;
      targetUrl = input.url;
    } else if (input instanceof URL) {
      targetUrl = input.toString();
    } else {
      targetUrl = input;
    }

    // Only proxy http(s) requests to external hosts — skip anything already
    // targeting the proxy itself, AI model APIs, or non-HTTP protocols.
    try {
      const parsed = new URL(targetUrl);
      const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
      const shouldBypassProxy =
        targetUrl.startsWith(proxyUrl) ||
        (parsed.hostname === "127.0.0.1" && parsed.port === "7447") ||
        (parsed.hostname === "localhost" && parsed.port === "7447") ||
        isAiProviderUrl(targetUrl, parsed.hostname);

      if (!isHttp || shouldBypassProxy) {
        return originalFetch(input, init);
      }
    } catch {
      // Malformed URL — pass through to let native fetch produce the error.
      return originalFetch(input, init);
    }

    // Build proxy request headers.
    const headers = new Headers(
      originalRequest ? originalRequest.headers : (init?.headers ?? {})
    );

    // Propagate X-Resource header if the caller set it.
    // The proxy enforces its own sanitization; we just pass it through.
    // The caller may have set it on the original request or in init.headers.

    // Build the proxy request. We send the original URL in X-Target-URL
    // and let the proxy forward it with injected credentials.
    headers.set("X-Target-URL", targetUrl);

    const pid = process.env.EVAL_PROCESS_ID;
    if (pid && UUID_RE.test(pid)) {
      headers.set('X-Process-ID', pid);
    }

    // Forward body from original request or init.
    const body =
      init?.body ?? (originalRequest ? await cloneBody(originalRequest) : null);

    const method =
      init?.method ??
      (originalRequest?.method ?? "GET");

    let proxyResponse: Response;
    try {
      proxyResponse = await originalFetch(`${proxyUrl}/proxy`, {
        method,
        headers,
        body,
        // Never follow redirects on proxy leg — handled by proxy itself.
        redirect: "follow",
      });
    } catch {
      // Proxy unreachable — fall back to native fetch so the SDK receives a real
      // HTTP response and its own retry/fallback logic (e.g. model downgrade) can run.
      logger.warn(
        `[credential-proxy] proxy unreachable at ${proxyUrl}, falling back to native fetch for ${targetUrl}`
      );
      return originalFetch(input, init);
    }

    return proxyResponse;
  };

  _installed = true;
}

/**
 * Restore the original fetch. Primarily for testing.
 */
export function uninstallFetchInterceptor(): void {
  if (!_installed || !_originalFetch) return;
  globalThis.fetch = _originalFetch;
  delete (globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch;
  _originalFetch = null;
  _installed = false;
  _bypassBaseUrls = null;
}

async function cloneBody(req: Request): Promise<BodyInit | null> {
  if (!req.body) return null;
  try {
    return await req.arrayBuffer();
  } catch {
    return null;
  }
}
