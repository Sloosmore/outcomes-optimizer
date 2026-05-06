import { REQUEST_TIMEOUT_MS, MAX_RESPONSE_SIZE } from "../config.js";

/**
 * Get a fetch function that wraps globalThis.fetch with a default
 * AbortSignal.timeout so callers get automatic request timeouts.
 *
 * Outbound HTTP proxy routing is handled by the credential-proxy interceptor
 * when active, or by the runtime's native fetch implementation otherwise.
 */
export function getProxyFetch(
  timeoutMs: number = REQUEST_TIMEOUT_MS
): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
    return globalThis.fetch(url, {
      ...init,
      signal,
    });
  }) as typeof fetch;
}

/**
 * Safely parse JSON from a response with size limit enforcement
 *
 * Prevents memory exhaustion from large/malformed API responses.
 */
export async function safeJsonParse<T>(
  response: Response,
  maxSize: number = MAX_RESPONSE_SIZE
): Promise<T> {
  // Check Content-Length header first (if available)
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxSize) {
    throw new Error(
      `Response size ${contentLength} bytes exceeds limit of ${maxSize} bytes`
    );
  }

  // Read response as text to check actual size
  const text = await response.text();
  if (text.length > maxSize) {
    throw new Error(
      `Response size ${text.length} bytes exceeds limit of ${maxSize} bytes`
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
    throw new Error(
      `Failed to parse API response as JSON: ${error instanceof Error ? error.message : error}. Response preview: ${preview}`
    );
  }
}
