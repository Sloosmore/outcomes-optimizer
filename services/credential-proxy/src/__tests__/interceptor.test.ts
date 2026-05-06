/**
 * Unit tests for interceptor.ts — X-Process-ID injection and fetch restoration.
 *
 * Strategy:
 *   1. Replace globalThis.fetch with a vi.fn() BEFORE calling installFetchInterceptor()
 *      so the interceptor captures the mock as its internal `originalFetch`.
 *   2. After installation, globalThis.fetch is the proxied version.
 *   3. Calling fetch('https://...') triggers the proxy path, which calls the mock
 *      (originalFetch) with the proxy request including assembled headers.
 *   4. Inspect mockFetch.mock.calls[0] to verify headers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installFetchInterceptor,
  uninstallFetchInterceptor,
} from "../interceptor.js";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Install a mock as the "native" fetch so the interceptor captures it.
  mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
  globalThis.fetch = mockFetch;
  installFetchInterceptor();
});

afterEach(() => {
  uninstallFetchInterceptor();
  delete process.env.EVAL_PROCESS_ID;
});

describe("installFetchInterceptor — X-Process-ID injection", () => {
  it("injects X-Process-ID header when EVAL_PROCESS_ID is a valid UUID", async () => {
    process.env.EVAL_PROCESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

    await fetch("https://httpbin.org/get");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    const headers = init.headers as Headers;
    expect(headers.get("X-Process-ID")).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
  });

  it("does NOT inject X-Process-ID header when EVAL_PROCESS_ID is unset", async () => {
    // Ensure the env var is absent.
    delete process.env.EVAL_PROCESS_ID;

    await fetch("https://httpbin.org/get");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    const headers = init.headers as Headers;
    expect(headers.get("X-Process-ID")).toBeNull();
  });
});

describe("installFetchInterceptor — X-Process-ID validation", () => {
  it("does NOT inject X-Process-ID when EVAL_PROCESS_ID is not a valid UUID", async () => {
    process.env.EVAL_PROCESS_ID = "not-a-uuid; DROP TABLE users";

    await fetch("https://httpbin.org/get");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    const headers = init.headers as Headers;
    expect(headers.get("X-Process-ID")).toBeNull();
  });
});

describe("uninstallFetchInterceptor — fetch restoration", () => {
  it("restores globalThis.fetch to the original after uninstall", () => {
    // At this point the interceptor is installed — globalThis.fetch is proxiedFetch.
    const proxiedFetch = globalThis.fetch;

    uninstallFetchInterceptor();

    // After uninstall, globalThis.fetch should be back to the mock (original).
    expect(globalThis.fetch).toBe(mockFetch);
    expect(globalThis.fetch).not.toBe(proxiedFetch);

    // Re-install so afterEach's uninstall doesn't throw.
    globalThis.fetch = mockFetch;
    installFetchInterceptor();
  });
});

describe("installFetchInterceptor — proxy unreachable fallback", () => {
  it("falls back to native fetch when proxy is unreachable", async () => {
    const expectedResponse = new Response("fallback", { status: 200 });
    let callCount = 0;

    // Reinstall with a mock that fails on the first (proxy) call.
    uninstallFetchInterceptor();
    mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call targets the proxy — simulate network error.
        throw new TypeError("fetch failed");
      }
      return Promise.resolve(expectedResponse);
    });
    globalThis.fetch = mockFetch;
    installFetchInterceptor();

    const result = await fetch("https://api.github.com/repos");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should use the original URL, not the proxy URL.
    const [fallbackUrl] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(fallbackUrl).toBe("https://api.github.com/repos");
    expect(result).toBe(expectedResponse);
  });

  it("does not leak proxy headers (X-Target-URL, X-Process-ID) on fallback", async () => {
    process.env.EVAL_PROCESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    let callCount = 0;

    uninstallFetchInterceptor();
    mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new TypeError("fetch failed");
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    globalThis.fetch = mockFetch;
    installFetchInterceptor();

    await fetch("https://api.github.com/repos");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Fallback call should use original args — no proxy-specific headers.
    const [, fallbackInit] = mockFetch.mock.calls[1] as [string, RequestInit | undefined];
    const fallbackHeaders = fallbackInit?.headers;
    if (fallbackHeaders instanceof Headers) {
      expect(fallbackHeaders.get("X-Target-URL")).toBeNull();
      expect(fallbackHeaders.get("X-Process-ID")).toBeNull();
    }
    // If no headers were passed (undefined init), that's also safe.
  });
});

describe("installFetchInterceptor — AI provider bypass", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CREDENTIAL_PROXY_BYPASS_URLS;
  });

  it("bypasses proxy for known AI provider hosts", async () => {
    await fetch("https://api.openai.com/v1/chat/completions");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("bypasses proxy for api.anthropic.com", async () => {
    await fetch("https://api.anthropic.com/v1/messages");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://api.anthropic.com/v1/messages");
  });

  it("bypasses proxy for ANTHROPIC_BASE_URL custom gateway", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://172.18.0.1:8317";
    // Re-install so the interceptor picks up the updated env via reset cache.
    uninstallFetchInterceptor();
    mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch;
    installFetchInterceptor();

    await fetch("http://172.18.0.1:8317/v1/messages");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://172.18.0.1:8317/v1/messages");
  });

  it("bypasses proxy for URLs matching CREDENTIAL_PROXY_BYPASS_URLS", async () => {
    process.env.CREDENTIAL_PROXY_BYPASS_URLS = "https://my-gateway.internal";
    uninstallFetchInterceptor();
    mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch;
    installFetchInterceptor();

    await fetch("https://my-gateway.internal/v1/chat");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://my-gateway.internal/v1/chat");
  });

  it("does NOT bypass proxy for subdomain of bypass URL (prefix spoofing guard)", async () => {
    process.env.CREDENTIAL_PROXY_BYPASS_URLS = "https://my-gateway.internal";
    uninstallFetchInterceptor();
    mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch;
    installFetchInterceptor();

    await fetch("https://my-gateway.internal.evil.com/steal");

    expect(mockFetch).toHaveBeenCalledOnce();
    // Should have been rewritten to the proxy URL, not the original.
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toMatch(/^http:\/\/127\.0\.0\.1:7447/);
  });

  it("routes non-AI-provider URLs through the proxy", async () => {
    await fetch("https://api.github.com/repos");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toMatch(/^http:\/\/127\.0\.0\.1:7447/);
  });
});
