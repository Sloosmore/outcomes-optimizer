/**
 * Credential storage for YouTube OAuth tokens
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, CREDENTIALS_FILE } from "../config.js";
import type { OAuthCredentials } from "../adapters/types.js";
import { isInterceptorActive, PROXY_MANAGED } from "../adapters/token-exchange.js";

const CREDENTIALS_PATH = join(STATE_DIR, CREDENTIALS_FILE);

/**
 * Ensure state directory exists
 */
async function ensureStateDir(): Promise<void> {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Save OAuth credentials
 */
export async function saveCredentials(
  credentials: OAuthCredentials
): Promise<void> {
  await ensureStateDir();
  await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}

/**
 * Load OAuth credentials from env vars or file.
 *
 * When the interceptor is active, returns a synthetic expired credential
 * even if no env vars are set — the proxy manages the real tokens.
 */
export async function loadCredentials(): Promise<OAuthCredentials | null> {
  // Interceptor mode: proxy manages credentials, return synthetic expired creds
  // to trigger a refresh via exchangeRefreshToken() which sets X-Resource.
  if (isInterceptorActive()) {
    return {
      access_token: "",
      refresh_token: PROXY_MANAGED,
      token_type: "Bearer",
      expires_at: new Date(0).toISOString(), // Expired — forces refresh via exchangeRefreshToken
    };
  }

  // Prefer env var (CI/CD)
  if (process.env.YOUTUBE_REFRESH_TOKEN) {
    return {
      access_token: "",
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
      token_type: "Bearer",
      expires_at: new Date(0).toISOString(), // Expired — will auto-refresh
    };
  }

  if (!existsSync(CREDENTIALS_PATH)) {
    return null;
  }

  try {
    const data = await readFile(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(data) as OAuthCredentials;
  } catch (err) {
    // Log error for debugging - corrupted credentials should be noticed
    console.error(
      `Warning: Failed to load credentials: ${err instanceof Error ? err.message : "unknown error"}`
    );
    return null;
  }
}

/**
 * Check if credentials exist (env vars, file, or interceptor active)
 */
export function hasCredentials(): boolean {
  return isInterceptorActive() || !!process.env.YOUTUBE_REFRESH_TOKEN || existsSync(CREDENTIALS_PATH);
}

/**
 * Delete credentials
 */
export async function deleteCredentials(): Promise<void> {
  if (existsSync(CREDENTIALS_PATH)) {
    const { unlink } = await import("node:fs/promises");
    await unlink(CREDENTIALS_PATH);
  }
}
