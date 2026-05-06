/**
 * Integration test: Supabase REST API via credential proxy
 *
 * Verifies that the credential proxy resolves SUPABASE_SERVICE_KEY from
 * Doppler and injects it as Authorization: Bearer on requests to the
 * Supabase project URL — without the service key ever appearing in the
 * agent process environment.
 *
 * Requires:
 *   - CREDENTIAL_PROXY_URL env var pointing to a running proxy sidecar
 *   - DOPPLER_SERVICE_TOKEN set so the proxy can resolve credentials
 *   - SUPABASE_SERVICE_KEY must NOT be in agent env
 *     (pass env -u SUPABASE_SERVICE_KEY when running)
 *   - SUPABASE_URL in env (public, not a secret)
 *
 * Run with:
 *   CREDENTIAL_PROXY_URL=http://127.0.0.1:7447 \
 *   SUPABASE_URL=https://example.supabase.co \
 *   env -u SUPABASE_SERVICE_KEY \
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/supabase.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { installFetchInterceptor } from "../../interceptor.js";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? "https://example.supabase.co";
const SKIP = !process.env.CREDENTIAL_PROXY_URL && process.env.CI !== "true";

describe.skipIf(SKIP)("Supabase integration via credential proxy", () => {
  beforeAll(() => {
    installFetchInterceptor();
  });

  it("agent process has no raw SUPABASE_SERVICE_KEY in environment", () => {
    expect(process.env.SUPABASE_SERVICE_KEY).toBeUndefined();
  });

  it("GET /rest/v1/ (schema) returns 200 — proxy attests credential injection", async () => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: {
        "X-Resource": "supabase-example",
        "Accept": "application/json",
      },
    });

    // Verify the request actually went through the proxy and credentials were injected.
    expect(response.headers.get("x-proxied-by")).toBe("credential-proxy");
    expect(response.headers.get("x-credential-injected")).toBe("true");
    expect(response.headers.get("x-resource-resolved")).toBe("supabase-example");

    // 200 = authenticated. 401 = credential issue (never acceptable). 403 = auth ok, permission issue.
    expect(response.status).not.toBe(401);
    expect([200, 403]).toContain(response.status);
  }, 15_000);

  it("GET /rest/v1/resources returns rows — proxy attests credential injection", async () => {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/resources?select=id,name&limit=5`,
      {
        headers: {
          "X-Resource": "supabase-example",
          "Accept": "application/json",
          "Accept-Profile": "public",
        },
      }
    );

    // Explicit proxy chain verification.
    expect(response.headers.get("x-proxied-by")).toBe("credential-proxy");
    expect(response.headers.get("x-credential-injected")).toBe("true");

    expect(response.status).toBe(200);
    const rows = (await response.json()) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
  }, 15_000);
});
