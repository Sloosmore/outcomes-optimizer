import { REQUEST_TIMEOUT_MS } from "../config.js";

/**
 * Detect whether the credential-proxy interceptor is active.
 * When active, adapters delegate auth to the proxy via X-Resource headers.
 */
export function isInterceptorActive(): boolean {
  return !!(globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch;
}

/**
 * Get a fetch function that wraps globalThis.fetch with a default
 * AbortSignal.timeout so callers get automatic request timeouts.
 *
 * Outbound HTTP proxy routing is handled by the credential-proxy interceptor
 * when active, or by the runtime's native fetch implementation otherwise.
 */
export function getProxyFetch(timeoutMs: number = REQUEST_TIMEOUT_MS): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
    return globalThis.fetch(url, {
      ...init,
      signal,
    });
  }) as typeof fetch;
}
