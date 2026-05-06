import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedWebhook, WebhookNormalizer, InterceptorConfig } from "./types.js";
import { normalizeInstagram } from "./normalizers/instagram.js";
import { normalizeGithub } from "./normalizers/github.js";
import type { EventStore } from "./store/types.js";
import { ulid } from "./store/ulid.js";
import { resolveProxy } from "./proxy/resolve.js";
import type { ProxyAgent } from "undici";
import { type Logger, createLogger as _createLogger } from "@skill-networks/logger";

export type { InterceptorConfig };

const normalizers: Map<string, WebhookNormalizer> = new Map([
  ["instagram", normalizeInstagram],
  ["github", normalizeGithub],
]);

function verifySignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Construct and return the Hono application for the agent-interceptor.
 *
 * Events are normalised and written to the provided {@link EventStore}.
 * A separate consumer (e.g. `poll/consume.ts`) reads from the store and
 * forwards events to the gateway asynchronously.
 *
 * @param config - Validated interceptor configuration (see {@link InterceptorConfig}).
 * @param store  - Event store for persisting webhook events.
 */
export function createApp(config: InterceptorConfig, store: EventStore, logger?: Logger): Hono {
  const log = logger ?? _createLogger('interceptor');
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      mode: "store", // Indicates this is store-only mode, not direct forwarding
      endpointCount: Object.keys(config.endpointMap).length,
    });
  });

  app.get("/hooks/:mapping", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");

    if (mode === "subscribe") {
      if (token !== config.webhookVerifyToken) {
        return c.json({ error: "Invalid verify token" }, 403);
      }
      return c.text(challenge ?? "", 200);
    }

    return c.json({ error: "Missing hub.mode" }, 400);
  });

  app.post("/hooks/agent", async (c) => {
    // Reject early if endpoint is not configured
    if (!config.agentSecret) {
      return c.json({ error: "Agent endpoint not configured" }, 503);
    }

    // Auth check — use timing-safe comparison to prevent token oracle attacks
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    let tokenMatch = false;
    try {
      tokenMatch = timingSafeEqual(Buffer.from(token), Buffer.from(config.agentSecret));
    } catch {
      // Buffers differ in length — not equal
    }
    if (!tokenMatch) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Validate gateway is configured before doing anything further
    if (!config.gatewayUrl || !config.gatewayUrl.startsWith("https://") || !config.gatewayAuthToken) {
      return c.json({ error: "Gateway not configured" }, 503);
    }

    // Parse and validate body
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { id, type, timestamp, data } = body as Record<string, unknown>;
    const missing: string[] = [];
    if (!id) missing.push("id");
    if (!type) missing.push("type");
    if (!timestamp) missing.push("timestamp");
    if (missing.length > 0) {
      log.warn("Validation failure: missing required fields", { fields: missing, reason: "required fields absent" });
      return c.json({ error: `Missing required fields: ${missing.join(", ")}` }, 400);
    }

    // Validate format of id and type to prevent injection into sessionKey
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      log.warn("Validation failure: invalid id", { field: "id", reason: "must be a valid UUID" });
      return c.json({ error: "id must be a valid UUID" }, 400);
    }
    if (typeof type !== "string" || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(type)) {
      log.warn("Validation failure: invalid type", { field: "type", reason: "must be a dot-namespaced string" });
      return c.json({ error: "type must be a dot-namespaced string (e.g. agent.instruction)" }, 400);
    }
    if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp)) {
      log.warn("Validation failure: invalid timestamp", { field: "timestamp", reason: "must be ISO-8601" });
      return c.json({ error: "timestamp must be an ISO-8601 string" }, 400);
    }

    // Validate data is a plain object if provided
    if (data !== undefined && (typeof data !== "object" || Array.isArray(data) || data === null)) {
      log.warn("Validation failure: invalid data", { field: "data", reason: "must be a JSON object" });
      return c.json({ error: "data must be a JSON object" }, 400);
    }

    const dataObj = (data ?? {}) as Record<string, unknown>;
    const rawResource = dataObj["resource"];
    if (rawResource !== undefined && rawResource !== null && typeof rawResource !== "string") {
      return c.json({ error: "data.resource must be a string" }, 400);
    }
    if (typeof rawResource === "string" && rawResource.length > 0 && !/^[a-zA-Z0-9_-]{1,128}$/.test(rawResource)) {
      return c.json({ error: "data.resource must match [a-zA-Z0-9_-]{1,128}" }, 400);
    }
    const resourceName = typeof rawResource === "string" && rawResource.length > 0 ? rawResource : null;

    // Route based on target: "sub" spawns an isolated agent session; "main" (default) wakes the main session.
    // gatewaySubUrl defaults to gatewayUrl — swap GATEWAY_SUB_URL env var to change runtime without code changes.
    const target = typeof dataObj["target"] === "string" ? dataObj["target"] : "main";
    if (target !== "main" && target !== "sub") {
      log.warn("Validation failure: invalid target", { field: "target", reason: 'must be "main" or "sub"' });
      return c.json({ error: 'Invalid target. Must be "main" or "sub".' }, 400);
    }

    let forwardUrl: string;
    let forwardBody: Record<string, unknown>;

    if (target === "sub") {
      // Sub-agent: isolated session, non-blocking relative to main.
      const subBaseUrl = config.gatewaySubUrl;
      if (!subBaseUrl || !subBaseUrl.startsWith("https://")) {
        return c.json({ error: "Sub-agent gateway not configured" }, 503);
      }

      // Pass the NL message through as-is. The agent reads the contract and figures out
      // what to do from the skill reference. No parsing, no translation, no business logic here.
      if (typeof dataObj["message"] !== "string") {
        return c.json({ error: "data.message must be a string" }, 400);
      }
      if (dataObj["message"].length > 16384) {
        return c.json({ error: "data.message exceeds maximum length of 16384 characters" }, 400);
      }
      const taskMessage = dataObj["message"];

      // Validate caller-provided sessionKey if present.
      // This is a routing field — the caller can override the default session isolation key.
      let resolvedSessionKey = `sub:${type}:${id}`;
      const callerSessionKey = dataObj["sessionKey"];
      if (callerSessionKey !== undefined) {
        if (typeof callerSessionKey !== "string" || callerSessionKey.length === 0) {
          return c.json({ error: "data.sessionKey must be a non-empty string" }, 400);
        }
        if (callerSessionKey.length > 256) {
          return c.json({ error: "data.sessionKey exceeds maximum length of 256 characters" }, 400);
        }
        const allowedPrefixes = config.allowedSessionKeyPrefixes ?? ["sub:"];
        const hasValidPrefix = allowedPrefixes.some((prefix) => callerSessionKey.startsWith(prefix));
        if (!hasValidPrefix) {
          return c.json({ error: `data.sessionKey must start with one of: ${allowedPrefixes.join(", ")}` }, 400);
        }
        resolvedSessionKey = callerSessionKey;
      }

      // Build payload using the configured runtime adapter.
      // "openclaw" (default): OpenClaw /hooks/agent shape.
      // "custom": generic shape for other runtimes (swap GATEWAY_RUNTIME env var).
      const runtime = config.gatewayRuntime ?? "openclaw";
      forwardUrl = `${subBaseUrl}/hooks/agent`;
      if (runtime === "openclaw") {
        forwardBody = {
          message: taskMessage,
          agentId: "hooks",
          sessionKey: resolvedSessionKey,
          name: "SubAgent",
          wakeMode: "now",
        };
      } else {
        // "custom" — generic payload; adapt receiving runtime as needed.
        forwardBody = { message: taskMessage, id, type, timestamp };
      }
    } else {
      // Main session: inject as a system event / wake.
      const message = `[Agent Event]\nid: ${id}\ntype: ${type}\ntimestamp: ${timestamp}\ndata: ${JSON.stringify(dataObj)}`;
      forwardUrl = `${config.gatewayUrl}/hooks/agent`;
      forwardBody = {
        message,
        agentId: "hooks",
        sessionKey: `agent:${type}:${id}`,
        name: "Agent",
        wakeMode: "now",
      };
    }

    // Use sub-specific auth token when routing to sub-agent gateway.
    const authToken = (target === "sub")
      ? (config.gatewaySubAuthToken ?? config.gatewayAuthToken)
      : config.gatewayAuthToken;

    // Resolve proxy agent if a resource name is present and DB is configured.
    let proxyAgent: ProxyAgent | null = null;
    if (resourceName && config.dbSql) {
      try {
        proxyAgent = await resolveProxy(resourceName, process.env, config.dbSql);
      } catch (err) {
        // Misconfigured proxy env var — fail safe: surface as 503
        log.error("Proxy resolution failed", err instanceof Error ? err : { error: String(err), resource: resourceName });
        return c.json({ error: "Proxy misconfigured" }, 503);
      }
    }

    let response: Response;
    try {
      response = await fetch(forwardUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`,
        },
        body: JSON.stringify(forwardBody),
        signal: AbortSignal.timeout(30_000),
        ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      if (proxyAgent && (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || isTimeout)) {
        return c.json({ error: "Proxy unreachable" }, 503);
      }
      return c.json({ error: "Gateway unreachable" }, 502);
    } finally {
      // Close the per-request ProxyAgent to release its connection pool.
      if (proxyAgent) proxyAgent.close().catch(() => {});
    }

    if (!response.ok) {
      log.error("Gateway returned non-2xx", { upstreamStatus: response.status });
      return c.json({ error: "Gateway returned non-2xx", status: response.status }, 502);
    }

    log.info("Agent request forwarded", { type: String(type), target, status: 202 });
    return c.json({ status: "forwarded", target }, 202);
  });

  app.post("/hooks/:mapping", async (c) => {
    const mapping = c.req.param("mapping");
    const normalizerName = config.endpointMap[mapping];

    if (!normalizerName) {
      return c.json({ error: "Unknown mapping" }, 404);
    }

    const normalizer = normalizers.get(normalizerName);
    if (!normalizer) {
      return c.json({ error: `Normalizer "${normalizerName}" not found` }, 404);
    }

    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return c.json({ error: "Failed to read request body" }, 400);
    }

    // Per-endpoint secret lookup: endpointSecrets[mapping] > webhookSecret > skip
    const endpointSecret = config.endpointSecrets?.[mapping];
    const effectiveSecret = endpointSecret === "__SKIP__" 
      ? undefined 
      : (endpointSecret ?? config.webhookSecret);
    
    if (effectiveSecret) {
      const signature = c.req.header("x-hub-signature-256") ?? null;
      if (!verifySignature(rawBody, signature, effectiveSecret)) {
        return c.json({ error: "Invalid signature" }, 401);
      }
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const endpointPath = `/hooks/${mapping}`;
    const normalized: NormalizedWebhook | null = normalizer(body, endpointPath);

    if (!normalized) {
      return c.json({ error: "Unprocessable webhook payload" }, 422);
    }

    try {
      await store.put({
        id: `evt_${ulid()}`,
        source: normalized.source,
        type: normalized.eventType,
        timestamp: normalized.timestamp,
        data: normalized.data,
        raw: normalized.rawPayload,
      });
    } catch (err) {
      log.error("Event store failed", { error: String(err) });
      return c.json({ error: "Failed to persist event" }, 500);
    }

    return c.json({ status: "accepted", mode: "store" }, 202);
  });

  return app;
}
