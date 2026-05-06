/**
 * Security integration tests — negative-path coverage for the credential proxy.
 *
 * These tests verify that the proxy correctly REFUSES to inject credentials in
 * all the ways an attacker or misconfigured caller might try to abuse it:
 *
 *   1. No interceptor → direct API call fails (proves env isolation matters)
 *   2. Wrong X-Resource for a target URL → credential injection refused
 *   3. X-Resource allowlist mismatch → destination validation blocks injection
 *   4. SSRF guard → requests to RFC 1918 addresses are blocked
 *   5. X-Resource sanitization → special characters rejected
 *
 * Run with:
 *   CREDENTIAL_PROXY_URL=http://127.0.0.1:7447 \
 *   env -u GITHUB_PAT \
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/security.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  installFetchInterceptor,
  uninstallFetchInterceptor,
  getProxyUrl,
} from "../../interceptor.js";

const SKIP = !process.env.CREDENTIAL_PROXY_URL && process.env.CI !== "true";

// Keep a reference to the real fetch before the interceptor patches it.
const nativeFetch = globalThis.fetch;

describe.skipIf(SKIP)("credential proxy — security negative-path tests", () => {
  beforeAll(() => {
    installFetchInterceptor();
  });

  afterAll(() => {
    uninstallFetchInterceptor();
  });

  // ── 1. No credentials in env → direct call must fail ────────────────────────

  it("GitHub API returns 401 when called directly without interceptor (env isolation baseline)", async () => {
    // Bypass the interceptor by using nativeFetch directly — no proxy, no credential injection.
    // GITHUB_PAT must NOT be in env (stripped by caller with env -u GITHUB_PAT).
    expect(process.env.GITHUB_PAT).toBeUndefined();

    const response = await nativeFetch("https://api.github.com/user", {
      headers: { Accept: "application/vnd.github+json" },
    });

    // Without credentials, GitHub returns 401. This proves the test env
    // does not have the token — the proxy is the only source.
    expect(response.status).toBe(401);
  }, 15_000);

  // ── 2. Wrong X-Resource → x-credential-injected: false ─────────────────────

  it("wrong X-Resource for a URL → proxy reports no credential injected", async () => {
    // youtube-hay-maker is not allowed for api.github.com
    const response = await fetch("https://api.github.com/user", {
      headers: {
        "X-Resource": "youtube-hay-maker",
        "Accept": "application/vnd.github+json",
      },
    });

    expect(response.headers.get("x-proxied-by")).toBe("credential-proxy");
    // Destination validation: api.github.com is not in youtube-hay-maker's url allowlist.
    // Proxy must not inject any credential.
    expect(response.headers.get("x-credential-injected")).toBe("false");
    // GitHub returns 401 because no Authorization header was injected.
    expect(response.status).toBe(401);
  }, 15_000);

  // ── 3. X-Resource allowlist mismatch (cross-resource exfiltration) ───────────

  it("github-pat credential not injected for non-github destination", async () => {
    // Attacker tries to send GitHub PAT to their own server by setting X-Resource: github-pat
    // but targeting a non-github URL. Destination validation must block this.
    const proxyUrl = getProxyUrl();
    const response = await nativeFetch(`${proxyUrl}/proxy`, {
      method: "GET",
      headers: {
        "X-Target-URL": "https://httpbin.org/headers",
        "X-Resource": "github-pat",
      },
    });

    // Proxy either blocks entirely (returns error JSON) or forwards without credentials.
    // Either way, x-credential-injected must not be "true".
    const injected = response.headers.get("x-credential-injected");
    expect(injected).not.toBe("true");
  }, 15_000);

  // ── 4. SSRF guard — RFC 1918 addresses blocked ───────────────────────────────

  it("SSRF blocked: proxy refuses to forward to 192.168.1.1", async () => {
    const proxyUrl = getProxyUrl();
    const response = await nativeFetch(`${proxyUrl}/proxy`, {
      method: "GET",
      headers: {
        "X-Target-URL": "http://192.168.1.1/admin",
        "X-Resource": "github-pat",
      },
    });

    // SSRF guard returns 400 or 403 (never actually connects to RFC 1918 host).
    expect([400, 403, 502]).toContain(response.status);
    // No credentials injected toward internal network.
    expect(response.headers.get("x-credential-injected")).not.toBe("true");
  }, 10_000);

  it("SSRF blocked: proxy refuses to forward to 10.0.0.1", async () => {
    const proxyUrl = getProxyUrl();
    const response = await nativeFetch(`${proxyUrl}/proxy`, {
      method: "GET",
      headers: {
        "X-Target-URL": "http://10.0.0.1/internal",
        "X-Resource": "github-pat",
      },
    });

    expect([400, 403, 502]).toContain(response.status);
    expect(response.headers.get("x-credential-injected")).not.toBe("true");
  }, 10_000);

  it("SSRF blocked: proxy refuses to forward to loopback 127.0.0.1 (non-proxy port)", async () => {
    const proxyUrl = getProxyUrl();
    // Target a loopback address on a different port than the proxy itself.
    const response = await nativeFetch(`${proxyUrl}/proxy`, {
      method: "GET",
      headers: {
        "X-Target-URL": "http://127.0.0.1:22/ssh",
        "X-Resource": "github-pat",
      },
    });

    expect([400, 403, 502]).toContain(response.status);
    expect(response.headers.get("x-credential-injected")).not.toBe("true");
  }, 10_000);

  // ── 5. X-Resource sanitization — special characters rejected ─────────────────
  //
  // NOTE: We target a URL with no registered resource (example.com) so hostname
  // fallback routing does not silently inject credentials via a different resource.
  // api.github.com has a hostname fallback to github-pat — using it would mask
  // sanitization failures (bad X-Resource rejected but hostname fallback injects).

  it("X-Resource with path traversal characters is sanitized — no credential injected", async () => {
    const proxyUrl = getProxyUrl();
    // Use example.com — not in any resource's url allowlist, no hostname fallback.
    const response = await nativeFetch(`${proxyUrl}/proxy`, {
      headers: {
        "X-Target-URL": "https://example.com/",
        "X-Resource": "../../../etc/passwd",
      },
    });

    expect(response.headers.get("x-proxied-by")).toBe("credential-proxy");
    expect(response.headers.get("x-credential-injected")).toBe("false");
    // example.com with no credentials — any non-5xx is fine (it just won't have auth)
    expect(response.status).not.toBeGreaterThanOrEqual(500);
  }, 15_000);

  it("X-Resource exceeding 128 chars is sanitized — no credential injected", async () => {
    const proxyUrl = getProxyUrl();
    const longResource = "a".repeat(129);
    const response = await nativeFetch(`${proxyUrl}/proxy`, {
      headers: {
        "X-Target-URL": "https://example.com/",
        "X-Resource": longResource,
      },
    });

    expect(response.headers.get("x-proxied-by")).toBe("credential-proxy");
    expect(response.headers.get("x-credential-injected")).toBe("false");
  }, 15_000);

  it("X-Resource with special chars is sanitized — no credential injected", async () => {
    const proxyUrl = getProxyUrl();
    const response = await nativeFetch(`${proxyUrl}/proxy`, {
      headers: {
        "X-Target-URL": "https://example.com/",
        "X-Resource": "github-pat; DROP TABLE secrets",
      },
    });

    expect(response.headers.get("x-proxied-by")).toBe("credential-proxy");
    expect(response.headers.get("x-credential-injected")).toBe("false");
  }, 15_000);
});
