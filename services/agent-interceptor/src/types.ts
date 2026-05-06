import type { DbSql } from "./proxy/resolve.js";
export type { DbSql };

/**
 * A platform-agnostic representation of an inbound webhook event, produced
 * by a {@link WebhookNormalizer} before writing to the event store.
 */
export interface NormalizedWebhook {
  /** Originating platform (e.g. "instagram"). */
  source: string;
  /** Platform-specific event category (e.g. "messages", "comments"). */
  eventType: string;
  /** The interceptor route path that received the webhook (e.g. "/hooks/ig"). */
  endpointPath: string;
  /** Normalised event data extracted from the raw payload. */
  data: Record<string, unknown>;
  /** The original, unmodified request body. */
  rawPayload: unknown;
  /** ISO-8601 timestamp of when the webhook was received by the interceptor. */
  timestamp: string;
}

/**
 * A function that converts a platform-specific webhook body into a
 * {@link NormalizedWebhook}. Returns `null` when the payload cannot be
 * processed (e.g. unknown object type, missing required fields).
 */
export type WebhookNormalizer = (payload: unknown, endpointPath: string) => NormalizedWebhook | null;

/**
 * Runtime adapter identifier. Controls the payload shape sent to the sub-agent gateway.
 *
 * - `"openclaw"` (default): OpenClaw `/hooks/agent` payload shape.
 * - `"custom"`: Generic `{ message, id, type, timestamp }` — adapt as needed for other runtimes.
 */
export type GatewayRuntime = "openclaw" | "custom";

/**
 * Runtime configuration for the interceptor worker.
 *
 * Only contains webhook ingestion config. Gateway forwarding config
 * lives in the consumer (`poll/consume.ts`).
 */
export interface InterceptorConfig {
  /** 
   * Global HMAC-SHA256 secret used to verify `x-hub-signature-256` headers.
   * Used as fallback if no endpoint-specific secret is configured.
   */
  webhookSecret?: string;
  /**
   * Per-endpoint HMAC secrets. Keys are endpoint mapping names (e.g. "instagram", "github").
   * Use "__SKIP__" as the value to explicitly skip verification for an endpoint.
   */
  endpointSecrets?: Record<string, string>;
  /**
   * Maps URL path segments to normalizer names.
   * e.g. `{ "ig": "instagram" }` routes `/hooks/ig` through the Instagram normalizer.
   */
  endpointMap: Record<string, string>;
  /** Token compared against `hub.verify_token` during webhook subscription handshakes. */
  webhookVerifyToken?: string;
  /**
   * Bearer token for the `/hooks/agent` endpoint.
   * Parsed from `AGENT_SECRET` env var.
   */
  agentSecret?: string;
  /**
   * Base URL for the OpenClaw gateway (main session).
   * Parsed from `GATEWAY_URL` env var.
   */
  gatewayUrl?: string;
  /**
   * Bearer token for authenticating with the main gateway.
   * Parsed from `GATEWAY_AUTH_TOKEN` env var.
   */
  gatewayAuthToken?: string;
  /**
   * Base URL for routing sub-agent dispatch. Defaults to `gatewayUrl` if unset.
   * Set `GATEWAY_SUB_URL` to swap sub-agent runtimes without code changes.
   */
  gatewaySubUrl?: string;
  /**
   * Bearer token for the sub-agent gateway. Defaults to `gatewayAuthToken` if unset.
   * Set `GATEWAY_SUB_AUTH_TOKEN` when the sub runtime uses a different auth token.
   */
  gatewaySubAuthToken?: string;
  /**
   * Payload adapter for the sub-agent gateway.
   * - `"openclaw"` (default): OpenClaw `/hooks/agent` shape.
   * - `"custom"`: Generic `{ message, id, type, timestamp }` for other runtimes.
   * Parsed from `GATEWAY_RUNTIME` env var.
   */
  gatewayRuntime?: GatewayRuntime;
  /**
   * Optional database SQL executor for proxy resolution.
   * Injected at runtime or in tests; omit to skip proxy lookup.
   */
  dbSql?: DbSql;
  /**
   * Allowed prefixes for caller-provided sessionKey values.
   * If a caller passes `data.sessionKey` with a prefix not in this list, the request is rejected (400).
   * Parsed from `ALLOWED_SESSION_KEY_PREFIXES` env var (comma-separated). Defaults to `["sub:"]`.
   */
  allowedSessionKeyPrefixes?: string[];
}
