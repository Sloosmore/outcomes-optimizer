/**
 * Event consumer — polls the Cloudflare KV event store and forwards events
 * to the OpenClaw gateway's `/hooks/agent` endpoint.
 *
 * Designed to run from:
 * - An OpenClaw cron job (`agentTurn` payload)
 * - A Node.js script via `tsx`
 * - Any environment with `fetch()` available
 *
 * Environment variables:
 * - `CF_ACCOUNT_ID`    — Cloudflare account ID
 * - `CF_API_TOKEN`     — API token with Workers KV read/write
 * - `CF_KV_NAMESPACE`  — KV namespace ID
 * - `GATEWAY_URL`      — OpenClaw gateway base URL (default: http://localhost:3000)
 * - `GATEWAY_AUTH_TOKEN` — Bearer token for the gateway hooks endpoint
 * - `POLL_LIMIT`       — Max events per poll (default: 50)
 */

interface ConsumeResult {
  processed: number;
  failed: number;
  skipped: number;
  errors: string[];
}

interface KVListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

interface KVListResponse {
  success: boolean;
  result: KVListKey[];
  result_info: { count: number; cursor?: string };
}

import type { WebhookEvent } from "../store/types.js";

const EVENT_PREFIX = "evt:";

function isValidWebhookEvent(event: unknown): event is WebhookEvent {
  if (!event || typeof event !== "object") return false;

  const e = event as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.source === "string" &&
    typeof e.type === "string" &&
    typeof e.timestamp === "string" &&
    typeof e.data === "object" &&
    e.data !== null
  );
}

export async function consumeEvents(env?: Record<string, string | undefined>): Promise<ConsumeResult> {
  const e = env ?? process.env;

  const accountId = e.CF_ACCOUNT_ID;
  const apiToken = e.CF_API_TOKEN ?? e.CF_ACCOUNT_TOKEN;
  const kvNamespace = e.CF_KV_NAMESPACE;
  const gatewayUrl = (e.GATEWAY_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const gatewayToken = e.GATEWAY_AUTH_TOKEN;
  const limit = parseInt(e.POLL_LIMIT ?? "50", 10);

  if (!accountId || !apiToken || !kvNamespace) {
    throw new Error("Missing required env: CF_ACCOUNT_ID, CF_API_TOKEN/CF_ACCOUNT_TOKEN, CF_KV_NAMESPACE");
  }

  const kvBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvNamespace}`;
  const headers = { Authorization: `Bearer ${apiToken}` };

  // 1. List pending events with retry logic
  let listRes;
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    try {
      listRes = await fetch(`${kvBase}/keys?prefix=${EVENT_PREFIX}&limit=${limit}`, { headers });
      if (listRes.ok) break;
      
      if (listRes.status === 429) {
        // Rate limited - exponential backoff
        const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 30000);
        console.warn(`KV API rate limited, retrying in ${backoffMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        retryCount++;
        continue;
      }
      
      throw new Error(`KV list failed: ${listRes.status} ${await listRes.text()}`);
    } catch (err) {
      retryCount++;
      if (retryCount >= maxRetries) throw err;
      
      const backoffMs = Math.min(500 * retryCount, 5000);
      console.warn(`KV list attempt ${retryCount} failed, retrying in ${backoffMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  
  if (!listRes || !listRes.ok) {
    throw new Error(`KV list failed after ${maxRetries} retries`);
  }
  
  const listData = (await listRes.json()) as KVListResponse;
  const keys = listData.result ?? [];

  if (keys.length === 0) {
    return { processed: 0, failed: 0, skipped: 0, errors: [] };
  }

  const result: ConsumeResult = { processed: 0, failed: 0, skipped: 0, errors: [] };

  // 2. Process each event with concurrency protection
  for (const key of keys) {
    try {
      // Read and immediately delete to claim the event (atomic on KV level)
      // We accept small risk of losing event if process crashes between read and gateway
      const getRes = await fetch(`${kvBase}/values/${encodeURIComponent(key.name)}`, { headers });
      if (getRes.status === 404) {
        // Event already processed by another consumer instance
        result.skipped++;
        continue;
      }
      if (!getRes.ok) {
        result.failed++;
        result.errors.push(`Read failed for ${key.name}: ${getRes.status} ${await getRes.text()}`);
        continue;
      }

      // Immediately delete to prevent double-processing
      // This creates a small window where event could be lost if consumer crashes,
      // but prevents duplicate delivery which is worse for webhooks
      const deleteRes = await fetch(`${kvBase}/values/${encodeURIComponent(key.name)}`, {
        method: "DELETE",
        headers,
      });
      if (deleteRes.status !== 404 && !deleteRes.ok) {
        console.warn(`Failed to delete ${key.name} after read: ${deleteRes.status}`);
        // Continue processing - worst case is duplicate delivery
      }

      let event: Record<string, unknown>;
      try {
        event = await getRes.json() as Record<string, unknown>;
      } catch (parseErr) {
        result.failed++;
        result.errors.push(`Invalid JSON in ${key.name}: ${parseErr}`);
        continue;
      }

      // Validate event structure
      if (!isValidWebhookEvent(event)) {
        result.failed++;
        result.errors.push(`Invalid event structure in ${key.name}`);
        continue;
      }

      // Check event age and warn about approaching TTL expiration
      const eventAge = Date.now() - new Date(event.timestamp).getTime();
      const ageHours = eventAge / (1000 * 60 * 60);
      if (ageHours > 20) {
        console.warn(`Event ${key.name} is ${ageHours.toFixed(1)}h old, approaching 24h TTL expiration!`);
      }

      // Forward to gateway
      const gwHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (gatewayToken) {
        gwHeaders["Authorization"] = `Bearer ${gatewayToken}`;
      }

      const gwRes = await fetch(`${gatewayUrl}/hooks/agent`, {
        method: "POST",
        headers: gwHeaders,
        body: JSON.stringify({
          message: formatEventMessage(event),
          agentId: "hooks",
          sessionKey: `hook:${event.source}:${event.type}:${event.id}`, // Use event ID for deduplication
          name: capitalize(event.source),
          wakeMode: "now",
        }),
      });

      if (!gwRes.ok) {
        result.failed++;
        const gwError = await gwRes.text().catch(() => "Unknown error");
        result.errors.push(`Gateway rejected ${key.name}: ${gwRes.status} ${gwError}`);
        continue;
      }

      // Event was already deleted above to prevent double-processing
      result.processed++;
    } catch (err) {
      result.failed++;
      result.errors.push(`Error processing ${key.name}: ${String(err)}`);
    }
  }

  return result;
}

function formatEventMessage(event: WebhookEvent): string {
  return [
    `Source: ${event.source}`,
    `Event type: ${event.type}`,
    `Received at: ${event.timestamp}`,
    `Data:`,
    JSON.stringify(event.data, null, 2),
  ].join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// CLI entrypoint
if (typeof process !== "undefined" && process.argv[1]?.endsWith("consume.ts")) {
  consumeEvents()
    .then((r) => {
      console.log(`Processed: ${r.processed}, Failed: ${r.failed}, Skipped: ${r.skipped}`);
      if (r.errors.length) console.error("Errors:", r.errors);
      process.exit(r.failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error("Fatal:", e);
      process.exit(1);
    });
}
