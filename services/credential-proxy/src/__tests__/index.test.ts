/**
 * Unit tests for the credential-proxy HTTP server entry point (index.ts).
 *
 * Tests three story-5 behaviours:
 *   1. 502 guard: proxyUrlEnvVar set but proxyUrl undefined → 502 JSON response
 *   2. SocksProxyAgent: proxyUrl set → https.request called with SocksProxyAgent
 *   3. No agent: neither proxyUrlEnvVar nor proxyUrl set → nativeFetch called without agent
 *
 * Strategy: mock router.js (resolveCredentials + isBlockedBySSRF) and
 * globalThis.__nativeFetch so we can control what the server "sees" and
 * inspect what it forwards — without real Doppler/DB/upstream connections.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";

// ── Mock node:https so https.request doesn't make real network calls ──────────
// Must be hoisted (vi.mock calls are hoisted before imports by vitest).

vi.mock("node:https", () => {
  const mockRequest = vi.fn();
  return {
    default: { request: mockRequest },
    request: mockRequest,
  };
});

// ── Mock socks-proxy-agent to track instantiation ─────────────────────────────

vi.mock("socks-proxy-agent", () => {
  const MockSocksProxyAgent = vi.fn().mockImplementation(function (this: object, url: string) {
    (this as Record<string, unknown>)._proxyUrl = url;
  });
  return { SocksProxyAgent: MockSocksProxyAgent };
});

// ── Mock router module BEFORE importing the server ────────────────────────────

vi.mock("../router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../router.js")>();
  return {
    ...actual,
    // Always allow SSRF — tests use fake hostnames; we don't want SSRF to block.
    isBlockedBySSRF: vi.fn().mockResolvedValue(false),
    resolveCredentials: vi.fn(),
  };
});

// ── Mock the Doppler store so module-level init doesn't fail ──────────────────

vi.mock("../store/doppler.js", () => {
  class DopplerCredentialStore {
    get(_key: string): Promise<string> {
      return Promise.reject(new Error("not used in unit tests"));
    }
    invalidate(): void {}
  }
  return { DopplerCredentialStore };
});

// ── Import mocks + server (after vi.mock hoists) ──────────────────────────────

const routerModule = await import("../router.js");
const resolveCredentialsMock = routerModule.resolveCredentials as ReturnType<typeof vi.fn>;

// Import https mock so we can configure it per-test.
const httpsMod = await import("node:https");
const httpsRequestMock = httpsMod.default.request as ReturnType<typeof vi.fn>;

// Import SocksProxyAgent mock constructor.
const { SocksProxyAgent } = await import("socks-proxy-agent");

// Import the server — module side-effects run here (server starts on PORT env var or 7447).
// We override the port via env before import so the test server doesn't collide.
// Because vitest runs each test file in its own worker we just pick a safe port.
process.env.CREDENTIAL_PROXY_PORT = "17447";
const { server } = await import("../index.js");

// ── nativeFetch capture ───────────────────────────────────────────────────────

/** Tracks the most recent options passed to the mocked nativeFetch. */
let capturedFetchOptions: (RequestInit & { agent?: unknown }) | undefined;

const mockUpstreamResponse = {
  status: 200,
  headers: {
    forEach: (_cb: (v: string, k: string) => void) => {},
    get: (_key: string) => null,
  },
  arrayBuffer: async () => new ArrayBuffer(0),
};

// Install a mock nativeFetch on globalThis so handleProxy picks it up.
// handleProxy checks `(globalThis as any).__nativeFetch ?? globalThis.fetch`.
(globalThis as Record<string, unknown>).__nativeFetch = vi.fn().mockImplementation(
  async (_url: string, opts: RequestInit & { agent?: unknown }) => {
    capturedFetchOptions = opts;
    return mockUpstreamResponse as unknown as Response;
  }
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Make a GET /proxy request with the given headers and return the response. */
function proxyRequest(headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: 17447,
      path: "/proxy",
      method: "GET",
      headers,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * Configure the https.request mock to simulate a successful 200 response.
 * Calls the callback with a mock IncomingMessage-like emitter, and returns
 * a mock ClientRequest with .on('error'), .write(), and .end() methods.
 */
function setupHttpsMock200(): void {
  httpsRequestMock.mockImplementation(
    (_options: unknown, callback: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
      // Simulate IncomingMessage — an EventEmitter with statusCode/headers.
      const mockRes = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
      mockRes.statusCode = 200;
      mockRes.headers = {};

      // Mock ClientRequest returned by https.request.
      const mockReq = new EventEmitter();
      (mockReq as unknown as Record<string, unknown>).write = vi.fn();
      (mockReq as unknown as Record<string, unknown>).end = vi.fn().mockImplementation(() => {
        // Invoke the response callback asynchronously.
        setImmediate(() => {
          callback(mockRes);
          setImmediate(() => {
            mockRes.emit("end");
          });
        });
      });

      return mockReq;
    }
  );
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Wait for server to be listening (it may already be).
  await new Promise<void>((resolve) => {
    if (server.listening) {
      resolve();
    } else {
      server.once("listening", resolve);
    }
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  capturedFetchOptions = undefined;
  vi.mocked(resolveCredentialsMock).mockReset();
  httpsRequestMock.mockReset();
  vi.mocked(SocksProxyAgent).mockClear();
  (globalThis as Record<string, unknown>).__nativeFetch = vi.fn().mockImplementation(
    async (_url: string, opts: RequestInit & { agent?: unknown }) => {
      capturedFetchOptions = opts;
      return mockUpstreamResponse as unknown as Response;
    }
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleProxy — story 5: socks-proxy-agent + 502 guard", () => {
  it("502 guard: responds with 502 JSON when proxyUrlEnvVar is set but proxyUrl is undefined", async () => {
    resolveCredentialsMock.mockResolvedValue({
      injectHeaders: { Authorization: "Bearer tok" },
      proxyUrlEnvVar: "PROXY_01_URL",
      proxyUrl: undefined,
    });

    const { status, body } = await proxyRequest({
      "x-target-url": "https://graph.instagram.com/me",
      "x-resource": "instagram-squarebent",
    });

    expect(status).toBe(502);
    const parsed = JSON.parse(body) as { error: string };
    expect(parsed.error).toBe("Proxy URL not resolved");
  });

  it("SocksProxyAgent: https.request called with SocksProxyAgent when proxyUrl is set", async () => {
    resolveCredentialsMock.mockResolvedValue({
      injectHeaders: { Authorization: "Bearer tok" },
      proxyUrlEnvVar: "PROXY_01_URL",
      proxyUrl: "socks5://user:pass@isp.decodo.com:10001",
    });

    setupHttpsMock200();

    const { status } = await proxyRequest({
      "x-target-url": "https://graph.instagram.com/me",
      "x-resource": "instagram-squarebent",
    });

    expect(status).toBe(200);
    // SocksProxyAgent should have been instantiated with the proxy URL.
    expect(SocksProxyAgent).toHaveBeenCalledWith("socks5://user:pass@isp.decodo.com:10001");
    // https.request should have been called (not nativeFetch).
    expect(httpsRequestMock).toHaveBeenCalled();
  });

  it("502 guard: responds with 502 when proxyUrl has non-SOCKS scheme", async () => {
    resolveCredentialsMock.mockResolvedValue({
      injectHeaders: {},
      proxyUrlEnvVar: "PROXY_01_URL",
      proxyUrl: "https://not-a-socks-proxy.com:8080",
    });

    const { status, body } = await proxyRequest({
      "x-target-url": "https://graph.instagram.com/me",
      "x-resource": "instagram-squarebent",
    });

    expect(status).toBe(502);
    const parsed = JSON.parse(body) as { error: string };
    expect(parsed.error).toBe("Proxy URL is not a valid SOCKS URL");
  });

  it("502 guard: responds with 502 when proxyUrl uses socks5h:// (DNS rebinding risk)", async () => {
    resolveCredentialsMock.mockResolvedValue({
      injectHeaders: {},
      proxyUrlEnvVar: "PROXY_01_URL",
      proxyUrl: "socks5h://user:pass@isp.decodo.com:10001",
    });

    const { status, body } = await proxyRequest({
      "x-target-url": "https://graph.instagram.com/me",
      "x-resource": "instagram-squarebent",
    });

    expect(status).toBe(502);
    const parsed = JSON.parse(body) as { error: string };
    expect(parsed.error).toBe("Proxy URL is not a valid SOCKS URL");
  });

  it("400 guard: responds with 400 when SOCKS proxy targets non-HTTPS URL", async () => {
    resolveCredentialsMock.mockResolvedValue({
      injectHeaders: {},
      proxyUrlEnvVar: "PROXY_01_URL",
      proxyUrl: "socks5://user:pass@isp.decodo.com:10001",
    });

    const { status, body } = await proxyRequest({
      "x-target-url": "http://graph.instagram.com/me",
      "x-resource": "instagram-squarebent",
    });

    expect(status).toBe(400);
    const parsed = JSON.parse(body) as { error: string };
    expect(parsed.error).toBe("Only HTTPS targets are supported via SOCKS proxy");
  });

  it("no agent: nativeFetch called without agent when proxyUrlEnvVar and proxyUrl are both absent", async () => {
    resolveCredentialsMock.mockResolvedValue({
      injectHeaders: { Authorization: "Bearer tok" },
      // proxyUrlEnvVar and proxyUrl intentionally omitted
    });

    const { status } = await proxyRequest({
      "x-target-url": "https://graph.instagram.com/me",
      "x-resource": "instagram-squarebent",
    });

    expect(status).toBe(200);
    expect(capturedFetchOptions).toBeDefined();
    expect(capturedFetchOptions!.agent).toBeUndefined();
  });
});

describe("handleProxy — X-Process-ID header stripping", () => {
  it("does not forward X-Process-ID to upstream servers", async () => {
    resolveCredentialsMock.mockResolvedValue({
      injectHeaders: {},
      // no proxyUrl → uses nativeFetch path, capturedFetchOptions receives outbound headers
    });

    await proxyRequest({
      "x-target-url": "https://graph.instagram.com/me",
      "x-process-id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    });

    expect(capturedFetchOptions).toBeDefined();
    const outboundHeaders = capturedFetchOptions!.headers as Record<string, string>;
    expect(outboundHeaders).toBeDefined();
    const keys = Object.keys(outboundHeaders).map((k) => k.toLowerCase());
    expect(keys).not.toContain("x-process-id");
  });
});

