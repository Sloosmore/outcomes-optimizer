import type { EventStore, WebhookEvent } from "./types.js";

/**
 * Key prefix for all webhook events in the KV namespace.
 */
const KEY_PREFIX = "evt:";

/**
 * {@link EventStore} backed by Cloudflare Workers KV.
 *
 * Keys are structured as `evt:<id>` for stable idempotent writes.
 * Values are JSON-serialised {@link WebhookEvent} objects; metadata stores
 * the timestamp for chronological ordering when listing.
 *
 * KV has eventual consistency (~60s) which is acceptable for webhook
 * processing. For stricter ordering or at-least-once delivery, swap this
 * for a Queues-based implementation.
 */
export class KVEventStore implements EventStore {
  constructor(private readonly kv: KVNamespace) {}

  async put(event: WebhookEvent): Promise<void> {
    // Use just the event ID for true idempotency - same event ID always gets same key.
    // This ensures retries of the same event don't create duplicates.
    const key = `${KEY_PREFIX}${event.id}`;

    // KV put is already atomic - if the same key is written twice,
    // the second write will just overwrite with the same data.
    // No need to check-then-write which creates race conditions.

    // TTL of 24h as a safety net — events should be consumed much sooner.
    // Store timestamp in metadata for chronological ordering when listing
    await this.kv.put(key, JSON.stringify(event), {
      expirationTtl: 86_400,
      metadata: {
        fullKey: key,
        timestamp: event.timestamp
      }
    });
  }

  async list(limit = 100): Promise<WebhookEvent[]> {
    const keys = await this.kv.list({ prefix: KEY_PREFIX, limit });
    const events: WebhookEvent[] = [];

    for (const key of keys.keys) {
      const raw = await this.kv.get(key.name, "text");
      if (raw) {
        try {
          events.push(JSON.parse(raw) as WebhookEvent);
        } catch {
          // Corrupted entry — skip but don't block the batch.
          console.warn(`Skipping unparseable event: ${key.name}`);
        }
      }
    }

    // Sort events by timestamp to maintain chronological order
    // since keys are no longer chronologically ordered
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return events;
  }

  async delete(id: string): Promise<void> {
    // If id contains the full key format, use it directly
    if (id.startsWith(KEY_PREFIX)) {
      await this.kv.delete(id);
      return;
    }

    // Otherwise, construct the key directly from the event ID
    // Since we now use just the ID as the key suffix
    const key = `${KEY_PREFIX}${id}`;
    await this.kv.delete(key);
  }
}
