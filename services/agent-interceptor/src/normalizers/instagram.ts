import type { NormalizedWebhook, WebhookNormalizer } from "../types.js";

// Instagram batches multiple entries in a single webhook delivery. We process
// only the first entry to produce one NormalizedWebhook per request. This is
// intentional: the gateway routes each normalized event as a separate agent
// session, and multi-entry batches sharing a single gateway call would conflate
// unrelated events. If batching becomes important, the normalizer signature can
// be changed to return NormalizedWebhook[] in a future revision.

/**
 * {@link WebhookNormalizer} for Instagram webhook events.
 *
 * Expects a body with `{ object: "instagram", entry: [...] }`. Processes only
 * the first entry and its first change; returns `null` for any payload that
 * does not match the expected shape.
 *
 * @param payload      - Parsed JSON body from the inbound request.
 * @param endpointPath - The interceptor route path that received the webhook.
 */
export const normalizeInstagram: WebhookNormalizer = (payload: unknown, endpointPath: string): NormalizedWebhook | null => {
  if (typeof payload !== "object" || payload === null) return null;

  const p = payload as Record<string, unknown>;
  if (p.object !== "instagram") return null;

  const entry = p.entry;
  if (!Array.isArray(entry) || entry.length === 0) return null;

  const firstEntry = entry[0] as Record<string, unknown>;
  const changes = firstEntry.changes;

  let eventType: string;
  let data: Record<string, unknown>;

  if (Array.isArray(changes) && changes.length > 0) {
    const firstChange = changes[0] as Record<string, unknown>;
    eventType = String(firstChange.field ?? "unknown");
    data = (firstChange.value ?? {}) as Record<string, unknown>;
  } else {
    eventType = "unknown";
    data = firstEntry;
  }

  return {
    source: "instagram",
    eventType,
    endpointPath,
    data,
    rawPayload: payload,
    timestamp: new Date().toISOString(),
  };
};
