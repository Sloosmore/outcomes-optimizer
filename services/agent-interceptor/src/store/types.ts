import type { WebhookEvent } from "../contract.js";
export type { WebhookEvent };
/**
 * Durable store for webhook events.
 *
 * Implementations decouple the interceptor from the gateway: events are
 * written by the worker and consumed asynchronously by the gateway (or any
 * other consumer). Swapping the backing store (KV → Queues → R2) requires
 * only a new implementation of this interface.
 */
export interface EventStore {
  /** Persist a single event. Must be idempotent for the same `event.id`. */
  put(event: WebhookEvent): Promise<void>;
  /**
   * List pending events in chronological order.
   *
   * @param limit - Maximum number of events to return (default: 100).
   * @returns Events ordered oldest-first.
   */
  list(limit?: number): Promise<WebhookEvent[]>;
  /**
   * Remove an event after successful processing.
   *
   * @param keyOrId - Event ID or full storage key. For efficiency,
   *                  prefer full keys when available.
   */
  delete(keyOrId: string): Promise<void>;
}
