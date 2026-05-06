import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProxyAgent } from "undici";
import { resolveProxy, type DbSql } from "../proxy/resolve.js";
import { createApp, type InterceptorConfig } from "../app.js";
import type { EventStore, WebhookEvent } from "../store/types.js";

// ---------------------------------------------------------------------------
// Minimal mock store
// ---------------------------------------------------------------------------

class MockEventStore implements EventStore {
  async put(_event: WebhookEvent): Promise<void> {}
  async list(): Promise<WebhookEvent[]> { return []; }
  async delete(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbSql(rows: Array<Record<string, unknown>>): DbSql {
  return vi.fn().mockResolvedValue({ rows });
}

function makeValidPayload() {
  return {
    id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    type: "agent.test",
    timestamp: new Date().toISOString(),
    data: { hello: "world" },
  };
}

function makePayloadWithResource(resource: string) {
  return {
    ...makeValidPayload(),
    data: { ...makeValidPayload().data, resource },
  };
}

// ---------------------------------------------------------------------------
// Test 1 — Proxy resolved (HTTPS)
// ---------------------------------------------------------------------------

describe("resolveProxy — proxy resolved", () => {
  it("returns a ProxyAgent when config points to https URL", async () => {
    const dbSql = makeDbSql([{ config: { urlEnvVar: "PROXY_TEST_01_URL" } }]);
    const env: Record<string, string | undefined> = {
      PROXY_TEST_01_URL: "https://proxy.example.com:443",
    };

    const result = await resolveProxy("instagram-squarebent", env, dbSql);

    expect(result).toBeInstanceOf(ProxyAgent);
  });
});

// ---------------------------------------------------------------------------
// Test 1a — SOCKS5 unsupported
// ---------------------------------------------------------------------------

describe("resolveProxy — socks5 unsupported", () => {
  it("throws when proxy URL uses socks5:// protocol", async () => {
    const dbSql = makeDbSql([{ config: { urlEnvVar: "PROXY_TEST_01_URL" } }]);
    const env: Record<string, string | undefined> = {
      PROXY_TEST_01_URL: "socks5://user:pass@1.2.3.4:1080",
    };

    await expect(resolveProxy("instagram-squarebent", env, dbSql)).rejects.toThrow(
      /not supported/
    );
  });
});

// ---------------------------------------------------------------------------
// Test 1b — Proxy resolved (HTTPS)
// ---------------------------------------------------------------------------

describe("resolveProxy — https proxy resolved", () => {
  it("returns a ProxyAgent for https:// proxy URLs", async () => {
    const dbSql = makeDbSql([{ config: { urlEnvVar: "PROXY_HTTPS_URL" } }]);
    const env: Record<string, string | undefined> = {
      PROXY_HTTPS_URL: "https://proxy.example.com:8080",
    };

    const result = await resolveProxy("instagram-squarebent", env, dbSql);

    expect(result).toBeInstanceOf(ProxyAgent);
  });
});

// ---------------------------------------------------------------------------
// Test 1c — Invalid urlEnvVar naming convention
// ---------------------------------------------------------------------------

describe("resolveProxy — urlEnvVar naming violation", () => {
  it("throws when urlEnvVar does not match PROXY_* naming convention", async () => {
    const dbSql = makeDbSql([{ config: { urlEnvVar: "DATABASE_URL" } }]);
    const env: Record<string, string | undefined> = {
      DATABASE_URL: "postgres://localhost/mydb",
    };

    await expect(resolveProxy("instagram-squarebent", env, dbSql)).rejects.toThrow(
      /PROXY_/
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2 — No proxy
// ---------------------------------------------------------------------------

describe("resolveProxy — no proxy", () => {
  it("returns null when no resource link is found", async () => {
    const dbSql = makeDbSql([]);
    const env: Record<string, string | undefined> = {};

    const result = await resolveProxy("instagram-squarebent", env, dbSql);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Proxy env var not set
// ---------------------------------------------------------------------------

describe("resolveProxy — env var not set", () => {
  it("throws an error when the proxy URL env var is missing", async () => {
    const dbSql = makeDbSql([{ config: { urlEnvVar: "PROXY_TEST_01_URL" } }]);
    const env: Record<string, string | undefined> = {};

    await expect(resolveProxy("instagram-squarebent", env, dbSql)).rejects.toThrow(
      /not set|PROXY_TEST_01_URL/
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Proxy failure → 503
// ---------------------------------------------------------------------------

describe("/hooks/agent — proxy ECONNREFUSED → 503", () => {
  let mockStore: MockEventStore;

  beforeEach(() => {
    mockStore = new MockEventStore();
    vi.restoreAllMocks();
    process.env["PROXY_TEST_01_URL"] = "http://proxy.example.com:8080";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["PROXY_TEST_01_URL"];
  });

  it("returns 503 when fetch throws ECONNREFUSED after proxy is resolved", async () => {
    const dbSql = makeDbSql([{ config: { urlEnvVar: "PROXY_TEST_01_URL" } }]);

    // Use a valid http:// proxy URL so resolveProxy succeeds and fetch is actually called.
    const connRefused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const fetchMock = vi.fn().mockRejectedValue(connRefused);
    vi.stubGlobal("fetch", fetchMock);

    const config: InterceptorConfig = {
      endpointMap: {},
      agentSecret: "test-agent-secret",
      gatewayUrl: "https://gateway.example.com",
      gatewayAuthToken: "gw-token",
      dbSql,
    };

    const app = createApp(config, mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(makePayloadWithResource("instagram-squarebent")),
    });

    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/[Pp]roxy/);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Proxy attached when resource has proxy configured
// ---------------------------------------------------------------------------

describe("/hooks/agent — proxy agent attached when resource configured", () => {
  let mockStore: MockEventStore;

  beforeEach(() => {
    mockStore = new MockEventStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["PROXY_TEST_01_URL"];
  });

  it("calls fetch with an agent property when resource has proxy configured", async () => {
    const dbSql = makeDbSql([{ config: { urlEnvVar: "PROXY_TEST_01_URL" } }]);
    process.env["PROXY_TEST_01_URL"] = "https://proxy.example.com:8080";

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const config: InterceptorConfig = {
      endpointMap: {},
      agentSecret: "test-agent-secret",
      gatewayUrl: "https://gateway.example.com",
      gatewayAuthToken: "gw-token",
      dbSql,
    };

    const app = createApp(config, mockStore);
    await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(makePayloadWithResource("instagram-squarebent")),
    });

    expect(fetchMock).toHaveBeenCalled();
    const callInit = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(callInit["dispatcher"]).toBeDefined();
    expect(callInit["dispatcher"]).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — No proxy when resource absent
// ---------------------------------------------------------------------------

describe("/hooks/agent — no proxy when resource absent", () => {
  let mockStore: MockEventStore;

  beforeEach(() => {
    mockStore = new MockEventStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls fetch without an agent property when data has no resource field", async () => {
    const dbSql = vi.fn() as unknown as DbSql;
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const config: InterceptorConfig = {
      endpointMap: {},
      agentSecret: "test-agent-secret",
      gatewayUrl: "https://gateway.example.com",
      gatewayAuthToken: "gw-token",
      dbSql,
    };

    const app = createApp(config, mockStore);
    await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(makeValidPayload()),
    });

    expect(fetchMock).toHaveBeenCalled();
    const callInit = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(callInit["dispatcher"]).toBeUndefined();
    expect(dbSql).not.toHaveBeenCalled();
  });
});
