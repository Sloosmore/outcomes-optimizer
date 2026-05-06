/**
 * Google OAuth token exchange — standalone, no browser deps.
 *
 * Converts a refresh token into a short-lived access token using Google's
 * token endpoint.
 *
 * Dual-mode operation:
 *   - **Interceptor active**: Uses globalThis.fetch (intercepted) with
 *     X-Resource header. The proxy's oauth2-refresh mode injects
 *     client_id, client_secret, and refresh_token — the caller only
 *     sends grant_type=refresh_token.
 *   - **Standalone fallback**: Reads YOUTUBE_REALENTRY_CLIENT_ID and
 *     YOUTUBE_REALENTRY_CLIENT_SECRET from env and builds the full body.
 */

/**
 * Detect whether the credential-proxy interceptor is active.
 * Exported so other modules in this package can import it.
 */
export function isInterceptorActive(): boolean {
  return !!(globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch;
}

/** Placeholder used when the interceptor manages real credentials. */
export const PROXY_MANAGED = "proxy-managed";

/**
 * Exchange a Google OAuth refresh token for a short-lived access token.
 * Returns the access token and its lifetime in milliseconds.
 */
export async function exchangeRefreshToken(refreshToken: string): Promise<{ accessToken: string; expiresInMs: number }> {
  let fetchFn: typeof fetch;
  let body: URLSearchParams;
  let headers: Record<string, string>;

  if (isInterceptorActive()) {
    // Proxy mode: intercepted fetch injects client_id, client_secret,
    // and refresh_token via the oauth2-refresh resource config.
    fetchFn = globalThis.fetch;
    body = new URLSearchParams({ grant_type: "refresh_token" });
    headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Resource": "youtube-hay-maker-oauth",
    };
  } else {
    // Standalone fallback: build the full body from env vars.
    const clientId = process.env.YOUTUBE_REALENTRY_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_REALENTRY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error(
        "YOUTUBE_REALENTRY_CLIENT_ID and YOUTUBE_REALENTRY_CLIENT_SECRET must be set " +
          "to exchange a refresh token for an access token."
      );
    }

    body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    headers = { "Content-Type": "application/x-www-form-urlencoded" };

    // Use the unpatched fetch so this call does not go through the interceptor.
    fetchFn = (globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch ?? globalThis.fetch;
  }

  const response = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Token exchange failed: ${response.status} ${response.statusText} — ${text}`
    );
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number; error?: string };

  if (!data.access_token) {
    throw new Error(
      `Token exchange returned no access_token: ${JSON.stringify(data)}`
    );
  }

  // Google issues 3600s tokens; use the actual value with a small buffer.
  const expiresInMs = ((data.expires_in ?? 3600) - 60) * 1000;
  return { accessToken: data.access_token, expiresInMs };
}
