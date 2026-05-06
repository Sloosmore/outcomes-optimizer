import { ProxyAgent, fetch as undiciFetch, type RequestInfo, type RequestInit } from "undici";
import { REQUEST_TIMEOUT_MS } from "../config.js";

/**
 * Get a fetch function that respects proxy environment variables
 * and includes request timeouts (default 30s)
 *
 * Node.js native fetch doesn't use HTTP_PROXY/HTTPS_PROXY,
 * so we need to use undici with a ProxyAgent when proxies are configured.
 */
export function getProxyFetch(timeoutMs: number = REQUEST_TIMEOUT_MS): typeof fetch {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
                   process.env.HTTP_PROXY || process.env.http_proxy;

  if (proxyUrl) {
    const agent = new ProxyAgent(proxyUrl);
    return ((url: string | URL, init?: globalThis.RequestInit) => {
      const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
      return undiciFetch(url as RequestInfo, {
        ...init as RequestInit,
        signal,
        dispatcher: agent,
      });
    }) as typeof fetch;
  }

  // Wrap native fetch with timeout
  return ((url: string | URL, init?: globalThis.RequestInit) => {
    const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
    return fetch(url, { ...init, signal });
  }) as typeof fetch;
}
