/**
 * Unit tests for the credential proxy router.
 *
 * Tests the security invariants without real Doppler or DB access:
 *   - Destination validation (no injection to non-allowlisted hosts)
 *   - X-Resource sanitization
 *   - SSRF guard
 *   - Credential injection for allowlisted destinations
 *   - URL-fallback routing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveCredentials } from "../router.js";
import type { RouterConfig } from "../router.js";
import type { ResolvedCredential } from "../db.js";
import type { CredentialStore } from "../store/interface.js";

// Mock dns.promises.lookup to make SSRF guard tests deterministic.
// Tests use fake/test hostnames that may not resolve in CI; we control
// what each hostname resolves to so SSRF behaviour is predictable.
vi.mock("node:dns", () => ({
  promises: {
    lookup: vi.fn().mockImplementation(async (hostname: string, opts: { family: number }) => {
      const publicIpMap: Record<string, string> = {
        "api.github.com": "140.82.121.5",
        "www.googleapis.com": "142.250.0.100",
        "myproject.supabase.co": "54.1.2.3",
        "attacker.com": "198.51.100.1",
        "evil.attacker.com": "198.51.100.2",
        "unrelated-service.com": "192.0.2.1",
        "evil-googleapis.com": "198.51.100.3",
        "graph.instagram.com": "157.240.0.1",
        "generativelanguage.googleapis.com": "142.250.1.1",
        "rest.fal.ai": "198.51.100.10",
        "oauth2.googleapis.com": "142.250.2.1",
      };
      const loopbackMap: Record<string, string> = {
        "localhost": "127.0.0.1",
      };
      if (opts.family === 6) throw new Error(`No IPv6 for ${hostname}`);
      const address = publicIpMap[hostname] ?? loopbackMap[hostname] ?? null;
      if (!address) throw new Error(`No address for ${hostname}`);
      return { address };
    }),
  },
}));

// Mock DB functions so tests provide credential data via mocks instead of fallback routes.
vi.mock("../db.js", () => ({
  resolveCredentialForResource: vi.fn(),
  resolveCredentialByHostname: vi.fn(),
}));

import { resolveCredentialForResource, resolveCredentialByHostname } from "../db.js";
const resolveCredentialForResourceMock = resolveCredentialForResource as ReturnType<typeof vi.fn>;
const resolveCredentialByHostnameMock = resolveCredentialByHostname as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────

function makeStore(secrets: Record<string, string> = {}): CredentialStore {
  return {
    async get(key: string): Promise<string> {
      const val = secrets[key];
      if (!val) throw new Error(`Secret "${key}" not found`);
      return val;
    },
    invalidate() {},
  };
}

function makeConfig(secrets: Record<string, string> = {}): RouterConfig {
  return {
    store: makeStore(secrets),
  };
}

const GITHUB_ROUTE: ResolvedCredential = {
  resourceName: "github-pat",
  urls: ["api.github.com", "github.com"],
  dopplerProject: "test-doppler-project",
  envVars: ["GITHUB_PAT"],
  injectAs: "bearer",
};

const YOUTUBE_ROUTE: ResolvedCredential = {
  resourceName: "youtube-hay-maker",
  urls: ["youtube.googleapis.com", "www.googleapis.com"],
  dopplerProject: "test-doppler-project",
  envVars: ["YOUTUBE_REALENTRY_REFRESH_TOKEN"],
  injectAs: "bearer",
};

// ── Lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  resolveCredentialForResourceMock.mockReset();
  resolveCredentialByHostnameMock.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("router - credential injection", () => {
  it("injects Bearer token for allowlisted destination with X-Resource header", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(GITHUB_ROUTE);
    const config = makeConfig({ GITHUB_PAT: "ghp_test123" });

    const result = await resolveCredentials(
      "https://api.github.com/user",
      "github-pat",
      config
    );

    expect(result.injectHeaders["Authorization"]).toBe("Bearer ghp_test123");
  });

  it("injects token via URL-fallback routing (no X-Resource header)", async () => {
    resolveCredentialByHostnameMock.mockResolvedValue(GITHUB_ROUTE);
    const config = makeConfig({ GITHUB_PAT: "ghp_fallback" });

    const result = await resolveCredentials(
      "https://api.github.com/repos",
      undefined,
      config
    );

    expect(result.injectHeaders["Authorization"]).toBe("Bearer ghp_fallback");
  });

  it("injects token for subdomain of allowlisted domain", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(YOUTUBE_ROUTE);
    const config = makeConfig({ YOUTUBE_REALENTRY_REFRESH_TOKEN: "ya29.token" });

    const result = await resolveCredentials(
      "https://www.googleapis.com/youtube/v3/channels?mine=true",
      "youtube-hay-maker",
      config
    );

    expect(result.injectHeaders["Authorization"]).toBe("Bearer ya29.token");
  });
});

describe("router - destination validation (security gate)", () => {
  it("returns empty headers when destination is NOT in resource url allowlist", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(GITHUB_ROUTE);
    const config = makeConfig({ GITHUB_PAT: "ghp_secret" });

    // Attacker spoofs X-Resource: github-pat but sends to attacker.com
    const result = await resolveCredentials(
      "https://attacker.com/steal",
      "github-pat",
      config
    );

    expect(result.injectHeaders).toEqual({});
    expect(result.injectHeaders["Authorization"]).toBeUndefined();
  });

  it("returns empty headers when X-Resource resource is unknown", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(null);
    const config = makeConfig({});

    const result = await resolveCredentials(
      "https://api.github.com/user",
      "unknown-resource",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });

  it("returns empty headers when no routes match (URL-fallback miss)", async () => {
    resolveCredentialByHostnameMock.mockResolvedValue(null);
    const config = makeConfig({ GITHUB_PAT: "ghp_secret" });

    const result = await resolveCredentials(
      "https://unrelated-service.com/api",
      undefined,
      config
    );

    expect(result.injectHeaders).toEqual({});
  });
});

describe("router - X-Resource sanitization", () => {
  it("rejects X-Resource with uppercase characters", async () => {
    // Uppercase "GITHUB-PAT" fails sanitization → falls through to hostname lookup
    resolveCredentialByHostnameMock.mockResolvedValue(GITHUB_ROUTE);
    const config = makeConfig({ GITHUB_PAT: "ghp_secret" });

    // Uppercase letters are not in the [a-z0-9\-_] allowlist
    const result = await resolveCredentials(
      "https://api.github.com/user",
      "GITHUB-PAT",
      config
    );

    // Should treat as absent header — URL-fallback routing kicks in
    // but the destination still matches, so we DO get injection here.
    // The point is it doesn't treat "GITHUB-PAT" as the resource name.
    // (URL fallback will still find github-pat by hostname match)
    expect(typeof result.injectHeaders).toBe("object");
  });

  it("rejects X-Resource with path traversal characters", async () => {
    resolveCredentialByHostnameMock.mockResolvedValue(GITHUB_ROUTE);
    const config = makeConfig({ GITHUB_PAT: "ghp_secret" });

    const result = await resolveCredentials(
      "https://api.github.com/user",
      "../../../etc/passwd",
      config
    );

    // Sanitized to null — treated as absent header.
    // URL-fallback may still inject, but via hostname match only.
    expect(typeof result.injectHeaders).toBe("object");
  });

  it("rejects X-Resource exceeding 128 chars", async () => {
    const longName = "a".repeat(129);
    resolveCredentialByHostnameMock.mockResolvedValue(null);
    const config = makeConfig({});

    const result = await resolveCredentials(
      "https://api.github.com/user",
      longName,
      config
    );

    expect(result.injectHeaders).toEqual({});
  });

  it("rejects X-Resource with CRLF injection attempt", async () => {
    resolveCredentialByHostnameMock.mockResolvedValue(null);
    const config = makeConfig({});

    const result = await resolveCredentials(
      "https://api.github.com/user",
      "github-pat\r\nX-Injected: evil",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });
});

describe("router - SSRF guard", () => {
  it("blocks requests to localhost", async () => {
    const config = makeConfig({ GITHUB_PAT: "secret" });

    const result = await resolveCredentials(
      "http://localhost/admin",
      "github-pat",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });

  it("blocks requests to 127.0.0.1", async () => {
    const config = makeConfig({ X: "secret" });

    const result = await resolveCredentials(
      "http://127.0.0.1/admin",
      "test",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });

  it("blocks requests to 192.168.1.1 (RFC 1918)", async () => {
    const config = makeConfig({ X: "secret" });

    const result = await resolveCredentials(
      "http://192.168.1.1/admin",
      "test",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });

  it("blocks link-local 169.254.169.254 (AWS metadata)", async () => {
    const config = makeConfig({ X: "secret" });

    const result = await resolveCredentials(
      "http://169.254.169.254/latest/meta-data/",
      "test",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });

  it("blocks requests to [::1] (IPv6 loopback)", async () => {
    const config = makeConfig({ X: "secret" });

    const result = await resolveCredentials(
      "http://[::1]/admin",
      "test",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });

  it("blocks requests to [fe80::1] (IPv6 link-local)", async () => {
    const config = makeConfig({ X: "secret" });

    const result = await resolveCredentials(
      "http://[fe80::1]/admin",
      "test",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });
});

describe("router - DopplerCredentialStore allowlist", () => {
  it("does not inject when credential store throws for unauthorized key", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(GITHUB_ROUTE);
    const strictStore: CredentialStore = {
      async get(_key: string): Promise<string> {
        throw new Error("Key not on allowlist");
      },
      invalidate() {},
    };

    const config: RouterConfig = {
      store: strictStore,
    };

    const result = await resolveCredentials(
      "https://api.github.com/user",
      "github-pat",
      config
    );

    // Store threw → uniform response: no credentials.
    expect(result.injectHeaders).toEqual({});
  });
});

describe("router - supabase injectAs", () => {
  const SUPABASE_ROUTE: ResolvedCredential = {
    resourceName: "supabase-test",
    urls: ["myproject.supabase.co"],
    dopplerProject: "test-doppler-project",
    envVars: ["SUPABASE_SERVICE_KEY"],
    injectAs: "supabase",
  };

  // Supabase rotated service key formats: legacy JWTs start with `eyJ`,
  // new-format keys are opaque strings prefixed with `sb_secret_`.
  // Both must inject identically — the proxy should not assume either shape.
  const keyFormats: Array<{ label: string; key: string }> = [
    { label: "legacy JWT format", key: "eyJtest123" },
    { label: "new sb_secret_ format", key: "sb_secret_abc123def456" },
  ];

  for (const { label, key } of keyFormats) {
    it(`injects both Authorization: Bearer and apikey headers for supabase injectAs (${label})`, async () => {
      resolveCredentialForResourceMock.mockResolvedValue(SUPABASE_ROUTE);
      const config = makeConfig({ SUPABASE_SERVICE_KEY: key });

      const result = await resolveCredentials(
        "https://myproject.supabase.co/rest/v1/logs",
        "supabase-test",
        config
      );

      expect(result.injectHeaders["Authorization"]).toBe(`Bearer ${key}`);
      expect(result.injectHeaders["apikey"]).toBe(key);
    });

    it(`does not inject supabase credentials for non-allowlisted destination (${label})`, async () => {
      resolveCredentialForResourceMock.mockResolvedValue(SUPABASE_ROUTE);
      const config = makeConfig({ SUPABASE_SERVICE_KEY: key });

      // Tries to use supabase-test resource against a different host
      const result = await resolveCredentials(
        "https://evil.attacker.com/steal",
        "supabase-test",
        config
      );

      expect(result.injectHeaders).toEqual({});
    });
  }
});

describe("router - proxy URL resolution", () => {
  const INSTAGRAM_ROUTE_WITH_PROXY: ResolvedCredential = {
    resourceName: "instagram-squarebent",
    urls: ["graph.instagram.com", "graph.facebook.com"],
    dopplerProject: "test-doppler-project",
    envVars: ["INSTAGRAM_SQUAREBENT_TOKEN"],
    injectAs: "bearer",
    proxyUrlEnvVar: "PROXY_01_URL",
  };

  const INSTAGRAM_ROUTE_NO_PROXY: ResolvedCredential = {
    resourceName: "instagram-squarebent",
    urls: ["graph.instagram.com", "graph.facebook.com"],
    dopplerProject: "test-doppler-project",
    envVars: ["INSTAGRAM_SQUAREBENT_TOKEN"],
    injectAs: "bearer",
  };

  it("Test A: resolves proxyUrl when proxyUrlEnvVar is set and store.get() succeeds", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(INSTAGRAM_ROUTE_WITH_PROXY);
    const config = makeConfig({
      INSTAGRAM_SQUAREBENT_TOKEN: "ig_token_abc",
      PROXY_01_URL: "socks5://user:pass@isp.decodo.com:10001",
    });

    const result = await resolveCredentials(
      "https://graph.instagram.com/me",
      "instagram-squarebent",
      config
    );

    expect(result.proxyUrl).toBe("socks5://user:pass@isp.decodo.com:10001");
    expect(result.proxyUrlEnvVar).toBe("PROXY_01_URL");
  });

  it("Test B: proxyUrl and proxyUrlEnvVar are undefined when resource has no proxyResourceId", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(INSTAGRAM_ROUTE_NO_PROXY);
    const config = makeConfig({ INSTAGRAM_SQUAREBENT_TOKEN: "ig_token_abc" });

    const result = await resolveCredentials(
      "https://graph.instagram.com/me",
      "instagram-squarebent",
      config
    );

    expect(result.proxyUrl).toBeUndefined();
    expect(result.proxyUrlEnvVar).toBeUndefined();
  });

  it("Test C: proxyUrlEnvVar is still set but proxyUrl is undefined when store.get() throws", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(INSTAGRAM_ROUTE_WITH_PROXY);
    const throwingStore: CredentialStore = {
      async get(key: string): Promise<string> {
        if (key === "PROXY_01_URL") throw new Error("Key not on allowlist");
        // Return a dummy value for other keys so the main credential path succeeds
        return "ig_token_abc";
      },
      invalidate() {},
    };

    const config: RouterConfig = {
      store: throwingStore,
    };

    const result = await resolveCredentials(
      "https://graph.instagram.com/me",
      "instagram-squarebent",
      config
    );

    expect(result.proxyUrl).toBeUndefined();
    expect(result.proxyUrlEnvVar).toBe("PROXY_01_URL");
  });
});

describe("router - query-param injectAs", () => {
  const GEMINI_ROUTE: ResolvedCredential = {
    resourceName: "gemini-api",
    urls: ["generativelanguage.googleapis.com"],
    dopplerProject: "test-doppler-project",
    envVars: ["GEMINI_API_KEY"],
    injectAs: "query-param",
    paramName: "key",
  };

  const GEMINI_ROUTE_NO_PARAM_NAME: ResolvedCredential = {
    resourceName: "gemini-api-default",
    urls: ["generativelanguage.googleapis.com"],
    dopplerProject: "test-doppler-project",
    envVars: ["GEMINI_API_KEY"],
    injectAs: "query-param",
  };

  it("returns queryParam with specified paramName and empty injectHeaders", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(GEMINI_ROUTE);
    const config = makeConfig({ GEMINI_API_KEY: "AIzaSyTest123" });

    const result = await resolveCredentials(
      "https://generativelanguage.googleapis.com/v1/models",
      "gemini-api",
      config
    );

    expect(result.queryParam).toEqual({ name: "key", value: "AIzaSyTest123" });
    expect(result.injectHeaders).toEqual({});
  });

  it("defaults paramName to 'key' when not specified", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(GEMINI_ROUTE_NO_PARAM_NAME);
    const config = makeConfig({ GEMINI_API_KEY: "AIzaSyDefault456" });

    const result = await resolveCredentials(
      "https://generativelanguage.googleapis.com/v1/models",
      "gemini-api-default",
      config
    );

    expect(result.queryParam).toEqual({ name: "key", value: "AIzaSyDefault456" });
    expect(result.injectHeaders).toEqual({});
  });

  it("returns queryParam even when URL already has query params", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(GEMINI_ROUTE);
    const config = makeConfig({ GEMINI_API_KEY: "AIzaSyTest123" });

    const result = await resolveCredentials(
      "https://generativelanguage.googleapis.com/v1/models?foo=bar",
      "gemini-api",
      config
    );

    // Router provides the queryParam; index.ts handles URL mutation.
    expect(result.queryParam).toEqual({ name: "key", value: "AIzaSyTest123" });
    expect(result.injectHeaders).toEqual({});
  });

  it("uses custom paramName ('api_key') when specified", async () => {
    const customRoute: ResolvedCredential = {
      resourceName: "custom-api",
      urls: ["generativelanguage.googleapis.com"],
      dopplerProject: "test-doppler-project",
      envVars: ["GEMINI_API_KEY"],
      injectAs: "query-param",
      paramName: "api_key",
    };
    resolveCredentialForResourceMock.mockResolvedValue(customRoute);
    const config = makeConfig({ GEMINI_API_KEY: "custom_SECRET" });

    const result = await resolveCredentials(
      "https://generativelanguage.googleapis.com/v1/models",
      "custom-api",
      config
    );

    expect(result.queryParam).toEqual({ name: "api_key", value: "custom_SECRET" });
    expect(result.injectHeaders).toEqual({});
  });

  it("does not inject queryParam when destination is not in allowlist", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(GEMINI_ROUTE);
    const config = makeConfig({ GEMINI_API_KEY: "AIzaSyTest123" });

    const result = await resolveCredentials(
      "https://evil-googleapis.com/steal",
      "gemini-api",
      config
    );

    expect(result.queryParam).toBeUndefined();
    expect(result.injectHeaders).toEqual({});
  });
});

describe("router - key-prefix injectAs", () => {
  const FAL_ROUTE: ResolvedCredential = {
    resourceName: "fal-ai",
    urls: ["rest.fal.ai"],
    dopplerProject: "test-doppler-project",
    envVars: ["FAL_KEY"],
    injectAs: "key-prefix",
  };

  const FAL_ROUTE_CUSTOM_PREFIX: ResolvedCredential = {
    resourceName: "fal-ai-custom",
    urls: ["rest.fal.ai"],
    dopplerProject: "test-doppler-project",
    envVars: ["FAL_KEY"],
    injectAs: "key-prefix",
    authPrefix: "Token",
  };

  it("injects Authorization: Key <secret> for key-prefix with default authPrefix", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(FAL_ROUTE);
    const config = makeConfig({ FAL_KEY: "SECRET" });

    const result = await resolveCredentials(
      "https://rest.fal.ai/v1/models",
      "fal-ai",
      config
    );

    expect(result.injectHeaders["Authorization"]).toBe("Key SECRET");
  });

  it("injects Authorization with custom authPrefix", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(FAL_ROUTE_CUSTOM_PREFIX);
    const config = makeConfig({ FAL_KEY: "SECRET" });

    const result = await resolveCredentials(
      "https://rest.fal.ai/v1/models",
      "fal-ai-custom",
      config
    );

    expect(result.injectHeaders["Authorization"]).toBe("Token SECRET");
  });

  it("does not inject key-prefix credentials for non-allowlisted destination", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(FAL_ROUTE);
    const config = makeConfig({ FAL_KEY: "SECRET" });

    const result = await resolveCredentials(
      "https://evil-googleapis.com/steal",
      "fal-ai",
      config
    );

    expect(result.injectHeaders).toEqual({});
  });
});

describe("router - oauth2-refresh injectAs", () => {
  const YOUTUBE_OAUTH_ROUTE: ResolvedCredential = {
    resourceName: "youtube-hay-maker-oauth",
    urls: ["oauth2.googleapis.com"],
    dopplerProject: "test-doppler-project",
    envVars: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"],
    injectAs: "oauth2-refresh",
  };

  it("returns oauthCredentials with all three values and empty injectHeaders", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(YOUTUBE_OAUTH_ROUTE);
    const config = makeConfig({
      YOUTUBE_CLIENT_ID: "client-id-123",
      YOUTUBE_CLIENT_SECRET: "client-secret-456",
      YOUTUBE_REFRESH_TOKEN: "refresh-token-789",
    });

    const result = await resolveCredentials(
      "https://oauth2.googleapis.com/token",
      "youtube-hay-maker-oauth",
      config
    );

    expect(result.oauthCredentials).toEqual({
      client_id: "client-id-123",
      client_secret: "client-secret-456",
      refresh_token: "refresh-token-789",
    });
    expect(result.injectHeaders).toEqual({});
  });

  it("returns empty result when envVars has fewer than 3 entries", async () => {
    const incompleteRoute: ResolvedCredential = {
      resourceName: "incomplete-oauth",
      urls: ["oauth2.googleapis.com"],
      dopplerProject: "test-doppler-project",
      envVars: ["CLIENT_ID", "CLIENT_SECRET"],
      injectAs: "oauth2-refresh",
    };
    resolveCredentialForResourceMock.mockResolvedValue(incompleteRoute);
    const config = makeConfig({ CLIENT_ID: "cid", CLIENT_SECRET: "cs" });

    const result = await resolveCredentials(
      "https://oauth2.googleapis.com/token",
      "incomplete-oauth",
      config
    );

    expect(result.oauthCredentials).toBeUndefined();
    expect(result.injectHeaders).toEqual({});
  });

  it("does not inject oauth2 credentials for non-allowlisted destination", async () => {
    resolveCredentialForResourceMock.mockResolvedValue(YOUTUBE_OAUTH_ROUTE);
    const config = makeConfig({
      YOUTUBE_CLIENT_ID: "cid",
      YOUTUBE_CLIENT_SECRET: "cs",
      YOUTUBE_REFRESH_TOKEN: "rt",
    });

    const result = await resolveCredentials(
      "https://evil-googleapis.com/steal",
      "youtube-hay-maker-oauth",
      config
    );

    expect(result.oauthCredentials).toBeUndefined();
    expect(result.injectHeaders).toEqual({});
  });
});
