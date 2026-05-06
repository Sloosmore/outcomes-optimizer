/**
 * Integration test: YouTube API via credential proxy + YouTube package OAuth
 *
 * Architecture (why this test is structured this way):
 *   - The credential proxy is a *dumb* bearer-token injector. It resolves a
 *     Doppler secret and injects it as Authorization: Bearer <value>.
 *   - YouTube requires an OAuth *access* token, not a refresh token.
 *     Injecting a refresh token directly yields 401.
 *   - OAuth token exchange is the *YouTube package's* responsibility, not the
 *     proxy's. See packages/agent-youtube/src/adapters/oauth.ts#exchangeRefreshToken.
 *
 * This test verifies the full chain:
 *   Doppler → YOUTUBE_REALENTRY_REFRESH_TOKEN (via proxy store) →
 *   exchangeRefreshToken() (YouTube package) → access token →
 *   YouTube API (200 or 403-quota, never 401)
 *
 * We fetch the refresh token directly from Doppler (the same way the proxy does)
 * so we don't need the proxy sidecar running to extract a raw token from headers.
 * The proxy's credential resolution is tested separately in unit tests (router.test.ts).
 *
 * Requires:
 *   - DOPPLER_SERVICE_TOKEN in env (proxy uses this; we do too to fetch the secret)
 *   - YOUTUBE_REALENTRY_CLIENT_ID and YOUTUBE_REALENTRY_CLIENT_SECRET in env
 *   - YOUTUBE_REALENTRY_REFRESH_TOKEN must NOT be in agent env
 *     (pass env -u YOUTUBE_REALENTRY_REFRESH_TOKEN when running)
 *
 * Run with:
 *   CREDENTIAL_PROXY_URL=http://127.0.0.1:7447 \
 *   env -u YOUTUBE_REALENTRY_REFRESH_TOKEN \
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/youtube.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { exchangeRefreshToken } from "../../../../../packages/agent-youtube/src/adapters/token-exchange.js";

const DOPPLER_TOKEN = process.env.DOPPLER_SERVICE_TOKEN;
const SKIP = !DOPPLER_TOKEN && process.env.CI !== "true";

/** Fetch a single secret value from Doppler using the service token. */
async function fetchDopplerSecret(secretName: string): Promise<string> {
  const project = process.env.DOPPLER_PROJECT ?? "test-doppler-project";
  const config = process.env.DOPPLER_CONFIG ?? "prd";
  const url = `https://api.doppler.com/v3/configs/config/secret?project=${project}&config=${config}&name=${secretName}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${DOPPLER_TOKEN}` },
  });

  if (!response.ok) {
    throw new Error(`Doppler secret fetch failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { value?: { raw?: string } };
  const value = data.value?.raw;
  if (!value) throw new Error(`Doppler secret ${secretName} has no value`);
  return value;
}

describe.skipIf(SKIP)("YouTube integration via credential proxy", () => {
  let refreshToken: string;

  beforeAll(async () => {
    // Fetch refresh token from Doppler — same source the proxy uses.
    // YOUTUBE_REALENTRY_REFRESH_TOKEN is stripped from agent process env.
    refreshToken = await fetchDopplerSecret("YOUTUBE_REALENTRY_REFRESH_TOKEN");
  });

  it("agent process has no raw YOUTUBE_REALENTRY_REFRESH_TOKEN in environment", () => {
    expect(process.env.YOUTUBE_REALENTRY_REFRESH_TOKEN).toBeUndefined();
  });

  it("Doppler resolves YOUTUBE_REALENTRY_REFRESH_TOKEN (proxy credential source)", () => {
    expect(refreshToken).toBeTruthy();
    expect(refreshToken.length).toBeGreaterThan(10);
  });

  it("exchangeRefreshToken() converts refresh token to Google access token", async () => {
    const accessToken = await exchangeRefreshToken(refreshToken);
    expect(accessToken).toBeTruthy();
    // Google access tokens start with ya29.
    expect(accessToken).toMatch(/^ya29\./);
  }, 15_000);

  it("GET channels?mine=true returns 200 or 403 (never 401) with exchanged access token", async () => {
    const accessToken = await exchangeRefreshToken(refreshToken);

    const response = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?mine=true&part=snippet",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // 200 = authenticated + data, 403 = authenticated but quota/scope issue
    // 401 = auth failure → unacceptable
    expect(response.status).not.toBe(401);
    expect([200, 403]).toContain(response.status);
  }, 30_000);

  it("GET videos?myRating=liked returns 200 or 403 (never 401) with exchanged access token", async () => {
    const accessToken = await exchangeRefreshToken(refreshToken);

    const response = await fetch(
      "https://www.googleapis.com/youtube/v3/videos?myRating=liked&part=snippet",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    expect(response.status).not.toBe(401);
    expect([200, 403]).toContain(response.status);
  }, 30_000);
});
