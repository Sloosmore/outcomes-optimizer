/**
 * Standard Webhooks-aligned contract for webhook events.
 * @see https://www.standardwebhooks.com/
 *
 * This is the stable boundary between the interceptor and its consumers.
 * The implementation (Cloudflare Worker, Hookdeck, Composio, etc.) can be
 * swapped freely as long as it produces events conforming to this shape.
 */
export interface WebhookEvent {
  /** Unique event ID (e.g. `"evt_<ulid>"`). Standard Webhooks field. */
  id: string;
  /** Event type string (e.g. `"instagram.comments"`, `"github.push"`). Standard Webhooks field. */
  type: string;
  /** ISO-8601 timestamp of when the event was received. Standard Webhooks field. */
  timestamp: string;
  /** Normalised event data. Standard Webhooks field. */
  data: Record<string, unknown>;
  /** Originating platform (e.g. `"instagram"`, `"github"`). Extension to Standard Webhooks. */
  source: string;
  /** Original unmodified payload. Extension for debugging/replay only. */
  raw?: unknown;
}
