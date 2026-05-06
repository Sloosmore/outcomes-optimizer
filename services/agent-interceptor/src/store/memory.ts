import type { EventStore, WebhookEvent } from "./types.js";

/**
 * In-memory {@link EventStore} for local development and non-Cloudflare deployments.
 *
 * Events are not persisted across restarts. Use the {@link KVEventStore} in
 * production (Cloudflare Workers).
 */
export class MemoryEventStore implements EventStore {
  private events = new Map<string, WebhookEvent>();

  async put(event: WebhookEvent): Promise<void> {
    this.events.set(event.id, event);
  }

  async list(limit = 100): Promise<WebhookEvent[]> {
    return Array.from(this.events.values()).slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    this.events.delete(id);
  }
}
