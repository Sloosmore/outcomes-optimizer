import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeInstagram } from "../normalizers/instagram.js";
import { createApp, type InterceptorConfig } from "../app.js";
import { parseConfig } from "../config.js";
import { createStaticStore } from "@skill-networks/doppler-secrets";
import type { NormalizedWebhook } from "../types.js";
import type { EventStore, WebhookEvent } from "../store/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIGPayload(overrides: Record<string, unknown> = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: "123",
        time: 1234567890,
        changes: [
          {
            field: "comments",
            value: { media_id: "456", text: "nice pic!" },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeNormalized(overrides: Partial<NormalizedWebhook> = {}): NormalizedWebhook {
  return {
    source: "instagram",
    eventType: "comments",
    endpointPath: "/hooks/ig-trianglebender",
    data: { media_id: "456", text: "nice pic!" },
    rawPayload: makeIGPayload(),
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<InterceptorConfig> = {}): InterceptorConfig {
  return {
    endpointMap: { "ig-trianglebender": "instagram" },
    webhookVerifyToken: "my-verify-token",
    ...overrides,
  };
}

function signPayload(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// Mock EventStore for testing
class MockEventStore implements EventStore {
  private events = new Map<string, WebhookEvent>();
  public putCalled = 0;
  public shouldFailPut = false;

  async put(event: WebhookEvent): Promise<void> {
    this.putCalled++;
    if (this.shouldFailPut) {
      throw new Error("Mock store failure");
    }
    this.events.set(event.id, event);
  }

  async list(limit = 100): Promise<WebhookEvent[]> {
    return Array.from(this.events.values()).slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    this.events.delete(id);
  }

  getStoredEvent(id: string): WebhookEvent | undefined {
    return this.events.get(id);
  }

  clear(): void {
    this.events.clear();
    this.putCalled = 0;
    this.shouldFailPut = false;
  }
}

// ---------------------------------------------------------------------------
// Instagram normalizer
// ---------------------------------------------------------------------------

describe("Instagram normalizer", () => {
  it("normalizes a valid Instagram payload", () => {
    const result = normalizeInstagram(makeIGPayload(), "/hooks/ig-test");

    expect(result).not.toBeNull();
    expect(result!.source).toBe("instagram");
    expect(result!.eventType).toBe("comments");
    expect(result!.endpointPath).toBe("/hooks/ig-test");
    expect(result!.data).toEqual({ media_id: "456", text: "nice pic!" });
    expect(result!.rawPayload).toEqual(makeIGPayload());
    expect(result!.timestamp).toBeTruthy();
  });

  it("returns null for non-Instagram payload", () => {
    const result = normalizeInstagram({ object: "twitter", entry: [] }, "/hooks/x");
    expect(result).toBeNull();
  });

  it("returns null for empty entries", () => {
    const result = normalizeInstagram({ object: "instagram", entry: [] }, "/hooks/x");
    expect(result).toBeNull();
  });

  it("returns null for missing entries", () => {
    const result = normalizeInstagram({ object: "instagram" }, "/hooks/x");
    expect(result).toBeNull();
  });

  it("returns eventType 'unknown' when no changes present", () => {
    const payload = {
      object: "instagram",
      entry: [{ id: "123", time: 1234567890 }],
    };
    const result = normalizeInstagram(payload, "/hooks/ig-test");
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe("unknown");
    expect(result!.data).toEqual({ id: "123", time: 1234567890 });
  });

  it("uses first entry for multi-entry payloads", () => {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "first",
          changes: [{ field: "mentions", value: { user: "a" } }],
        },
        {
          id: "second",
          changes: [{ field: "likes", value: { user: "b" } }],
        },
      ],
    };
    const result = normalizeInstagram(payload, "/hooks/ig-test");
    expect(result!.eventType).toBe("mentions");
    expect(result!.data).toEqual({ user: "a" });
  });
});

// ---------------------------------------------------------------------------
// parseConfig
// ---------------------------------------------------------------------------

describe("parseConfig", () => {
  it("parses valid minimal env", () => {
    const config = parseConfig(createStaticStore({}));
    expect(config.endpointMap).toEqual({});
    expect(config.webhookSecret).toBeUndefined();
    expect(config.webhookVerifyToken).toBeUndefined();
  });

  it("parses ENDPOINT_MAP as JSON object", () => {
    const config = parseConfig(createStaticStore({
      ENDPOINT_MAP: '{"ig":"instagram","tw":"twitter"}',
    }));
    expect(config.endpointMap).toEqual({ ig: "instagram", tw: "twitter" });
  });

  it("rejects invalid ENDPOINT_MAP JSON", () => {
    expect(() => parseConfig(createStaticStore({ ENDPOINT_MAP: "not json" }))).toThrow(
      "ENDPOINT_MAP is not valid JSON"
    );
  });

  it("rejects ENDPOINT_MAP as array", () => {
    expect(() => parseConfig(createStaticStore({ ENDPOINT_MAP: "[]" }))).toThrow(
      "ENDPOINT_MAP must be a JSON object"
    );
  });

  it("rejects ENDPOINT_MAP with non-string values", () => {
    expect(() => parseConfig(createStaticStore({ ENDPOINT_MAP: '{"ig":123}' }))).toThrow(
      'ENDPOINT_MAP["ig"] must be a string'
    );
  });

  it("includes optional env vars when provided", () => {
    const config = parseConfig(createStaticStore({
      WEBHOOK_SECRET: "secret",
      WEBHOOK_VERIFY_TOKEN: "token",
      ENDPOINT_MAP: '{"ig":"instagram"}',
    }));
    expect(config.webhookSecret).toBe("secret");
    expect(config.webhookVerifyToken).toBe("token");
    expect(config.endpointMap).toEqual({ ig: "instagram" });
  });
});

// ---------------------------------------------------------------------------
// Webhook processing
// ---------------------------------------------------------------------------

describe("Webhook processing", () => {
  let mockStore: MockEventStore;

  beforeEach(() => {
    mockStore = new MockEventStore();
  });

  it("accepts webhook subscription verification with valid token", async () => {
    const app = createApp(makeConfig({ webhookVerifyToken: "verify-me" }), mockStore);
    const res = await app.request("/hooks/ig-trianglebender?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=test123");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("test123");
  });

  it("rejects webhook subscription with wrong token", async () => {
    const app = createApp(makeConfig({ webhookVerifyToken: "verify-me" }), mockStore);
    const res = await app.request("/hooks/ig-trianglebender?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test123");
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Invalid verify token");
  });

  it("rejects webhook subscription with missing mode", async () => {
    const app = createApp(makeConfig(), mockStore);
    const res = await app.request("/hooks/ig-trianglebender");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Missing hub.mode");
  });

  it("rejects unknown endpoint mapping", async () => {
    const app = createApp(makeConfig(), mockStore);
    const res = await app.request("/hooks/unknown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Unknown mapping");
  });

  it("rejects unknown normalizer", async () => {
    const app = createApp(makeConfig({ endpointMap: { test: "unknown" } }), mockStore);
    const res = await app.request("/hooks/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('Normalizer "unknown" not found');
  });

  it("rejects invalid request body", async () => {
    const app = createApp(makeConfig(), mockStore);
    const res = await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid json",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid JSON body");
  });

  it("rejects unprocessable payload", async () => {
    const app = createApp(makeConfig(), mockStore);
    const res = await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object: "twitter" }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("Unprocessable webhook payload");
  });

  it("verifies signature when webhook secret is configured", async () => {
    const body = JSON.stringify(makeIGPayload());
    const app = createApp(makeConfig({ webhookSecret: "test-secret" }), mockStore);

    // Valid signature
    const validSig = signPayload(body, "test-secret");
    const validRes = await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": validSig,
      },
      body,
    });
    expect(validRes.status).toBe(202);

    // Invalid signature
    const invalidRes = await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": "sha256=wrong",
      },
      body,
    });
    expect(invalidRes.status).toBe(401);
    const json = await invalidRes.json();
    expect(json.error).toBe("Invalid signature");
  });

  it("skips signature verification when no secret is configured", async () => {
    const app = createApp(makeConfig(), mockStore);
    const res = await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeIGPayload()),
    });
    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

describe("Payload shape", () => {
  let mockStore: MockEventStore;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(() => {
    mockStore = new MockEventStore();
    app = createApp(makeConfig(), mockStore);
  });

  afterEach(() => {
    mockStore.clear();
  });

  it("returns 200 for health check", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.endpointCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Store Mode Operations
// ---------------------------------------------------------------------------

describe("Store mode operations", () => {
  let mockStore: MockEventStore;

  beforeEach(() => {
    mockStore = new MockEventStore();
  });

  afterEach(() => {
    mockStore.clear();
  });

  it("stores events in KV when store is provided", async () => {
    const app = createApp(makeConfig(), mockStore);
    const res = await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeIGPayload()),
    });

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("accepted");
    expect(json.mode).toBe("store");
    expect(mockStore.putCalled).toBe(1);
  });

  it("stores correct event data structure", async () => {
    const app = createApp(makeConfig(), mockStore);
    await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeIGPayload()),
    });

    const storedEvents = await mockStore.list();
    expect(storedEvents).toHaveLength(1);
    
    const event = storedEvents[0];
    expect(event.id).toMatch(/^evt_/);
    expect(event.source).toBe("instagram");
    expect(event.type).toBe("comments");
    expect(event.timestamp).toBeTruthy();
    expect(event.data).toEqual({ media_id: "456", text: "nice pic!" });
    expect(event.raw).toEqual(makeIGPayload());
  });

  it("returns 500 when store fails", async () => {
    mockStore.shouldFailPut = true;
    const app = createApp(makeConfig(), mockStore);
    
    const res = await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeIGPayload()),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Failed to persist event");
  });

  it("does not forward to gateway in store mode", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const app = createApp(makeConfig(), mockStore);
    await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeIGPayload()),
    });

    // Should not call fetch for gateway forwarding
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockStore.putCalled).toBe(1);
  });

  it("indicates store mode in health check", async () => {
    const app = createApp(makeConfig(), mockStore);
    const res = await app.request("/health");
    
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("store");
  });

  it("works with signature verification in store mode", async () => {
    const body = JSON.stringify(makeIGPayload());
    const sig = signPayload(body, "test-secret");

    const app = createApp(makeConfig({ webhookSecret: "test-secret" }), mockStore);
    const res = await app.request("/hooks/ig-trianglebender", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": sig,
      },
      body,
    });

    expect(res.status).toBe(202);
    expect(mockStore.putCalled).toBe(1);
  });
});
// ---------------------------------------------------------------------------
// /hooks/agent endpoint
// ---------------------------------------------------------------------------

describe("/hooks/agent endpoint", () => {
  let mockStore: MockEventStore;

  beforeEach(() => {
    mockStore = new MockEventStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    mockStore.clear();
    vi.unstubAllGlobals();
  });

  function makeAgentConfig(overrides: Partial<InterceptorConfig> = {}): InterceptorConfig {
    return {
      endpointMap: {},
      agentSecret: "test-agent-secret",
      gatewayUrl: "https://gateway.example.com",
      gatewayAuthToken: "gw-token",
      ...overrides,
    };
  }

  function makeValidPayload() {
    return {
      id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      type: "agent.test",
      timestamp: new Date().toISOString(),
      data: { hello: "world" },
    };
  }

  it("returns 202 for valid payload and valid token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(makeValidPayload()),
    });

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("forwarded");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns 400 when id is missing", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const { id: _id, ...payload } = makeValidPayload();
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("id");
  });

  it("returns 400 when type is missing", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const { type: _type, ...payload } = makeValidPayload();
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("type");
  });

  it("returns 400 when timestamp is missing", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const { timestamp: _ts, ...payload } = makeValidPayload();
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("timestamp");
  });

  it("returns 401 when Authorization header is missing", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeValidPayload()),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is wrong", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong-token",
      },
      body: JSON.stringify(makeValidPayload()),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });

  it("returns 502 when OpenClaw returns 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(makeValidPayload()),
    });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toContain("Gateway");
  });

  it("returns 502 when OpenClaw is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(makeValidPayload()),
    });
    expect(res.status).toBe(502);
  });

  it("does not route /hooks/agent through the :mapping handler", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig({ endpointMap: { agent: "instagram" } }), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-agent-secret",
      },
      body: JSON.stringify(makeValidPayload()),
    });
    expect(res.status).toBe(202);
    expect(mockStore.putCalled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /hooks/agent — target routing (sub vs main)
// ---------------------------------------------------------------------------

describe("/hooks/agent target routing", () => {
  let mockStore: MockEventStore;

  beforeEach(() => {
    mockStore = new MockEventStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    mockStore.clear();
    vi.unstubAllGlobals();
  });

  function makeAgentConfig(overrides: Partial<InterceptorConfig> = {}): InterceptorConfig {
    return {
      endpointMap: {},
      agentSecret: "test-agent-secret",
      gatewayUrl: "https://main.example.com",
      gatewayAuthToken: "main-gw-token",
      gatewaySubUrl: "https://sub.example.com",
      gatewaySubAuthToken: "0d1d4836-cb22-4550-8697-066ebab826fa",
      gatewayRuntime: "openclaw",
      ...overrides,
    };
  }

  function makeValidPayload(dataOverrides: Record<string, unknown> = {}) {
    return {
      id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      type: "agent.instruction",
      timestamp: new Date().toISOString(),
      data: { message: "skill_resource_id: test-123\nrun_type: openclaw", ...dataOverrides },
    };
  }

  it("routes target=sub to gatewaySubUrl with sub auth token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", resourceId: "abc-123" })),
    });

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.target).toBe("sub");

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sub.example.com/hooks/agent");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer sub-gw-token");

    const body = JSON.parse(opts.body as string);
    expect(body.sessionKey).toMatch(/^sub:/);
    expect(body.message).toBe("skill_resource_id: test-123\nrun_type: openclaw");
  });

  it("routes target=main to gatewayUrl with main auth token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "main" })),
    });

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.target).toBe("main");

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://main.example.com/hooks/agent");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer main-gw-token");

    const body = JSON.parse(opts.body as string);
    expect(body.sessionKey).toMatch(/^agent:/);
  });

  it("defaults to main when target is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload()),
    });

    expect(res.status).toBe(202);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://main.example.com/hooks/agent");
  });

  it("returns 400 for unknown target value", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "unknown-runtime" })),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid target");
  });

  it("returns 503 when sub gateway URL is not https", async () => {
    const app = createApp(makeAgentConfig({ gatewaySubUrl: "http://insecure.example.com" }), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub" })),
    });

    expect(res.status).toBe(503);
  });

  it("passes NL message through to sub-agent as-is", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const nlMessage = "skill_resource_id: res-abc-123\nrun_type: openclaw\ncampaign_id: camp-def-456";
    const app = createApp(makeAgentConfig(), mockStore);
    await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({
        target: "sub",
        message: nlMessage,
      })),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.message).toBe(nlMessage);
  });


  it("returns 400 when data.message is missing for sub target", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", message: undefined })),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("data.message");
  });

  it("returns 400 when data.message exceeds 16384 chars for sub target", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", message: "x".repeat(16385) })),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("16384");
  });


  it("uses custom runtime payload shape when GATEWAY_RUNTIME=custom", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig({ gatewayRuntime: "custom" }), mockStore);
    await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", resourceId: "res-xyz" })),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Custom runtime: no OpenClaw-specific fields
    expect(body.sessionKey).toBeUndefined();
    expect(body.agentId).toBeUndefined();
    expect(body.wakeMode).toBeUndefined();
    // Generic fields present — message is NL passthrough
    expect(body.message).toBe("skill_resource_id: test-123\nrun_type: openclaw");
    expect(body.id).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    expect(body.type).toBe("agent.instruction");
  });

  it("falls back to main auth token when gatewaySubAuthToken is unset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig({ gatewaySubAuthToken: undefined }), mockStore);
    await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub" })),
    });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer main-gw-token");
  });
});

// ---------------------------------------------------------------------------
// parseConfig — new sub-agent fields
// ---------------------------------------------------------------------------

describe("parseConfig — sub-agent fields", () => {
  it("defaults gatewaySubUrl to gatewayUrl when GATEWAY_SUB_URL is unset", () => {
    const config = parseConfig(createStaticStore({ GATEWAY_URL: "https://main.example.com" }));
    expect(config.gatewaySubUrl).toBe("https://main.example.com");
  });

  it("uses GATEWAY_SUB_URL when set", () => {
    const config = parseConfig(createStaticStore({
      GATEWAY_URL: "https://main.example.com",
      GATEWAY_SUB_URL: "https://sub.example.com",
    }));
    expect(config.gatewaySubUrl).toBe("https://sub.example.com");
  });

  it("defaults gatewaySubAuthToken to gatewayAuthToken when GATEWAY_SUB_AUTH_TOKEN is unset", () => {
    const config = parseConfig(createStaticStore({ GATEWAY_AUTH_TOKEN: "main-token" }));
    expect(config.gatewaySubAuthToken).toBe("main-token");
  });

  it("uses GATEWAY_SUB_AUTH_TOKEN when set", () => {
    const config = parseConfig(createStaticStore({
      GATEWAY_AUTH_TOKEN: "main-token",
      GATEWAY_SUB_AUTH_TOKEN: "74926890-ce1d-412b-88d6-1b78a19b029c",
    }));
    expect(config.gatewaySubAuthToken).toBe("74926890-ce1d-412b-88d6-1b78a19b029c");
  });

  it("defaults gatewayRuntime to openclaw", () => {
    const config = parseConfig(createStaticStore({}));
    expect(config.gatewayRuntime).toBe("openclaw");
  });

  it("parses GATEWAY_RUNTIME=custom", () => {
    const config = parseConfig(createStaticStore({ GATEWAY_RUNTIME: "custom" }));
    expect(config.gatewayRuntime).toBe("custom");
  });

  it("throws on unknown GATEWAY_RUNTIME", () => {
    expect(() => parseConfig(createStaticStore({ GATEWAY_RUNTIME: "openfang" }))).toThrow(
      'GATEWAY_RUNTIME must be "openclaw" or "custom"'
    );
  });

  it("defaults allowedSessionKeyPrefixes to ['sub:'] when env var is unset", () => {
    const config = parseConfig(createStaticStore({}));
    expect(config.allowedSessionKeyPrefixes).toEqual(["sub:"]);
  });

  it("parses ALLOWED_SESSION_KEY_PREFIXES as comma-separated list", () => {
    const config = parseConfig(createStaticStore({
      ALLOWED_SESSION_KEY_PREFIXES: "sub:,process:,test:",
    }));
    expect(config.allowedSessionKeyPrefixes).toEqual(["sub:", "process:", "test:"]);
  });
});

// ---------------------------------------------------------------------------
// /hooks/agent sessionKey passthrough
// ---------------------------------------------------------------------------

describe("/hooks/agent sessionKey passthrough", () => {
  let mockStore: MockEventStore;

  beforeEach(() => {
    mockStore = new MockEventStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    mockStore.clear();
    vi.unstubAllGlobals();
  });

  function makeAgentConfig(overrides: Partial<InterceptorConfig> = {}): InterceptorConfig {
    return {
      endpointMap: {},
      agentSecret: "test-agent-secret",
      gatewayUrl: "https://main.example.com",
      gatewayAuthToken: "main-gw-token",
      gatewaySubUrl: "https://sub.example.com",
      gatewaySubAuthToken: "0d1d4836-cb22-4550-8697-066ebab826fa",
      gatewayRuntime: "openclaw",
      allowedSessionKeyPrefixes: ["sub:"],
      ...overrides,
    };
  }

  function makeValidPayload(dataOverrides: Record<string, unknown> = {}) {
    return {
      id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      type: "agent.instruction",
      timestamp: new Date().toISOString(),
      data: { message: "skill_resource_id: test-123\nrun_type: openclaw", ...dataOverrides },
    };
  }

  // 1. Valid caller-provided sessionKey for target=sub is used
  it("uses caller-provided sessionKey when valid prefix for target=sub", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", sessionKey: "sub:process:test-uuid" })),
    });

    expect(res.status).toBe(202);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sessionKey).toBe("sub:process:test-uuid");
  });

  // 2. Disallowed prefix rejects with 400
  it("rejects sessionKey with disallowed prefix", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", sessionKey: "evil:injection" })),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("sessionKey");
  });

  // 3. Empty string rejects with 400
  it("rejects empty string sessionKey", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", sessionKey: "" })),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("sessionKey");
  });

  // 4. sessionKey exceeding 256 chars rejects with 400
  it("rejects sessionKey exceeding 256 characters", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", sessionKey: "sub:process:" + "a".repeat(500) })),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("256");
  });

  // 5. Missing sessionKey falls back to sub:${type}:${id}
  it("falls back to sub:type:id when sessionKey is not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub" })),
    });

    expect(res.status).toBe(202);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sessionKey).toBe("sub:agent.instruction:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
  });

  // 6. target=main ignores sessionKey
  it("ignores sessionKey for target=main and uses agent: prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "main", sessionKey: "sub:process:uuid" })),
    });

    expect(res.status).toBe(202);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sessionKey).toMatch(/^agent:/);
    expect(body.sessionKey).not.toMatch(/^sub:/);
  });

  // 7. Valid sessionKey returns 202
  it("accepts valid sessionKey with sub:process: prefix and returns 202", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", sessionKey: "sub:process:valid-uuid" })),
    });

    expect(res.status).toBe(202);
  });

  // 8. agent: prefix rejected (wrong prefix)
  it("rejects sessionKey with agent: prefix (not in allowed list)", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", sessionKey: "agent:hijack:main" })),
    });

    expect(res.status).toBe(400);
  });

  // 9. 16384 char message WITH sessionKey → accepted
  it("accepts 16384 char message with sessionKey", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", message: "x".repeat(16384), sessionKey: "sub:process:test" })),
    });

    expect(res.status).toBe(202);
  });

  // 10. 16385 char message WITH sessionKey → rejected
  it("rejects 16385 char message even with valid sessionKey", async () => {
    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", message: "x".repeat(16385), sessionKey: "sub:process:test" })),
    });

    expect(res.status).toBe(400);
  });

  // 11. Gateway 503 with sessionKey → 502
  it("returns 502 when gateway returns 503 with sessionKey", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Service Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", sessionKey: "sub:process:test" })),
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toContain("Gateway");
  });

  // 12. Gateway timeout with sessionKey → 502
  it("returns 502 when gateway times out with sessionKey", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp(makeAgentConfig(), mockStore);
    const res = await app.request("/hooks/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-agent-secret" },
      body: JSON.stringify(makeValidPayload({ target: "sub", sessionKey: "sub:process:test" })),
    });

    expect(res.status).toBe(502);
  });
});
