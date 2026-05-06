/**
 * OAuth 2.0 flow for YouTube
 */

import { createServer } from "node:http";
import { URL } from "node:url";
import open from "open";
import { google } from "googleapis";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  YOUTUBE_SCOPES,
  OAUTH_REDIRECT_PORT,
  OAUTH_REDIRECT_PATH,
  OAUTH_TIMEOUT_MS,
  CLIENT_SECRETS_PATH,
} from "../config.js";
import { saveCredentials } from "../state/credentials.js";
import { exchangeRefreshToken, isInterceptorActive, PROXY_MANAGED } from "./token-exchange.js";
import type { OAuthCredentials } from "./types.js";

interface ClientSecrets {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
}

/**
 * Load client secrets from env vars or file.
 *
 * When the interceptor is active, returns placeholder values — the proxy
 * handles real OAuth credentials via X-Resource header routing.
 *
 * CI/CD: set all three env vars together:
 *   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
 */
async function loadClientSecrets(): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  // Interceptor mode: proxy manages OAuth credentials, use placeholders
  if (isInterceptorActive()) {
    return { clientId: PROXY_MANAGED, clientSecret: PROXY_MANAGED };
  }

  const hasClientId = !!process.env.YOUTUBE_CLIENT_ID;
  const hasClientSecret = !!process.env.YOUTUBE_CLIENT_SECRET;
  const hasRefreshToken = !!process.env.YOUTUBE_REFRESH_TOKEN;

  // Detect partial env var config — all three must be set together
  if (hasRefreshToken && (!hasClientId || !hasClientSecret)) {
    throw new Error(
      "YOUTUBE_REFRESH_TOKEN is set but YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are missing. " +
        "All three env vars are required for CI authentication."
    );
  }
  if ((hasClientId || hasClientSecret) && !hasRefreshToken) {
    throw new Error(
      `${hasClientId ? "YOUTUBE_CLIENT_ID" : "YOUTUBE_CLIENT_SECRET"} is set but YOUTUBE_REFRESH_TOKEN is missing. ` +
        "All three env vars are required for CI authentication."
    );
  }

  // Use env vars (CI/CD)
  if (hasClientId && hasClientSecret) {
    return {
      clientId: process.env.YOUTUBE_CLIENT_ID!,
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET!,
    };
  }

  if (!existsSync(CLIENT_SECRETS_PATH)) {
    throw new Error(
      `Client secrets not found. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN env vars, ` +
        `or download client_secrets.json from Google Cloud Console to ${CLIENT_SECRETS_PATH}`
    );
  }

  const data = await readFile(CLIENT_SECRETS_PATH, "utf-8");
  const secrets = JSON.parse(data) as ClientSecrets;

  const config = secrets.installed || secrets.web;
  if (!config) {
    throw new Error("Invalid client_secrets.json format");
  }

  return {
    clientId: config.client_id,
    clientSecret: config.client_secret,
  };
}

/**
 * Run OAuth flow and return credentials
 */
export async function runOAuthFlow(): Promise<OAuthCredentials> {
  const { clientId, clientSecret } = await loadClientSecrets();

  const redirectUri = `http://localhost:${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`;

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: YOUTUBE_SCOPES,
    prompt: "select_account consent", // Show account picker, force consent to get refresh token
  });

  // Start local server to receive callback
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout - did not complete within 2 minutes"));
    }, OAUTH_TIMEOUT_MS);

    const server = createServer((req, res) => {
      const url = new URL(req.url || "", `http://localhost:${OAUTH_REDIRECT_PORT}`);

      if (url.pathname === OAUTH_REDIRECT_PATH) {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          // Escape HTML to prevent XSS
          const safeError = error
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Authentication failed</h1><p>${safeError}</p>`);
          clearTimeout(timeout);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Authentication successful!</h1>" +
              "<p>You can close this window and return to the terminal.</p>"
          );
          clearTimeout(timeout);
          server.close();
          resolve(code);
          return;
        }

        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Missing authorization code</h1>");
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(OAUTH_REDIRECT_PORT, () => {
      console.log(`Opening browser for authentication...`);
      open(authUrl);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start OAuth server: ${err.message}`));
    });
  });

  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh token received. Try revoking access at https://myaccount.google.com/permissions and re-authenticating."
    );
  }

  const credentials: OAuthCredentials = {
    access_token: tokens.access_token || "",
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type || "Bearer",
    expires_at: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : new Date(Date.now() + 3600 * 1000).toISOString(),
  };

  // Save credentials
  await saveCredentials(credentials);

  return credentials;
}

/**
 * Create an authenticated OAuth2 client from credentials.
 *
 * When the interceptor is active, pre-fetches a fresh access token via
 * exchangeRefreshToken() (which sets X-Resource for proxy routing) so
 * that the OAuth2Client has a valid token for its entire session. This
 * avoids the problem of googleapis' internal refresh not setting
 * X-Resource headers.
 */
export async function createOAuth2Client(
  credentials: OAuthCredentials
): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const { clientId, clientSecret } = await loadClientSecrets();

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);

  let effectiveCredentials = credentials;

  if (isInterceptorActive()) {
    // Pre-fetch a fresh access token via the proxy so the OAuth2Client
    // starts with a valid token. This avoids relying on googleapis' built-in
    // refresh which doesn't set X-Resource headers for proxy routing.
    const { accessToken, expiresInMs } = await exchangeRefreshToken(credentials.refresh_token);
    effectiveCredentials = {
      ...credentials,
      access_token: accessToken,
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    };
  }

  oauth2Client.setCredentials({
    access_token: effectiveCredentials.access_token,
    refresh_token: effectiveCredentials.refresh_token,
    token_type: effectiveCredentials.token_type,
    expiry_date: new Date(effectiveCredentials.expires_at).getTime(),
  });

  // Set up automatic token refresh — skip file persistence in CI (env var mode)
  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.access_token && !process.env.YOUTUBE_REFRESH_TOKEN) {
      const updated: OAuthCredentials = {
        ...effectiveCredentials,
        access_token: tokens.access_token,
        expires_at: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : new Date(Date.now() + 3600 * 1000).toISOString(),
      };
      await saveCredentials(updated);
    }
  });

  return oauth2Client;
}
