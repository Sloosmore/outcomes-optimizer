import type { EmailSession, Email, EmailSummary } from "../adapters/types.js";
import { markSeen, loadState } from "../state/inbox.js";
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_S } from "../config.js";

/**
 * Options for waiting for an email
 */
export interface WaitOptions {
  /** Timeout in seconds (default: 60) */
  timeout?: number;
  /** Filter by sender (partial match) */
  from?: string;
  /** Filter by subject (partial match) */
  subject?: string;
  /** Polling interval in ms (default: 2000) */
  interval?: number;
  /** Show progress dots during polling (default: true for TTY) */
  showProgress?: boolean;
  /** Initial set of seen IDs (for tracking) */
  seenIds?: string[];
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a new email matching the given criteria
 *
 * @param session - Email session to use
 * @param options - Wait options
 * @returns The matching email
 * @throws Error if timeout is reached
 */
export async function waitForEmail(
  session: EmailSession,
  options: WaitOptions = {}
): Promise<Email> {
  const timeout = (options.timeout ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
  const interval = options.interval ?? DEFAULT_POLL_INTERVAL_MS;
  const startTime = Date.now();
  const showProgress = options.showProgress ?? process.stdout.isTTY;

  // Keep a local copy of seenIds as Set for O(1) lookups
  const seenSet = new Set(options.seenIds ?? []);

  while (Date.now() - startTime < timeout) {
    // Reload state to catch updates from other processes
    const freshState = await loadState();
    if (freshState) {
      // Merge any new seen IDs from disk
      for (const id of freshState.seenIds) {
        seenSet.add(id);
      }
    }

    const emails = await session.list();

    // Filter to unseen emails using Set for O(1) lookups
    const unseenEmails = emails.filter((e) => !seenSet.has(e.id));

    // Apply filters
    for (const summary of unseenEmails) {
      if (options.from && !summary.from.toLowerCase().includes(options.from.toLowerCase())) {
        continue;
      }
      if (options.subject && !summary.subject.toLowerCase().includes(options.subject.toLowerCase())) {
        continue;
      }

      // Found a match - read full email and mark as seen
      const email = await session.read(summary.id);
      await markSeen([summary.id]);
      if (showProgress) {
        process.stdout.write("\n"); // End progress line
      }
      return email;
    }

    // Show progress
    if (showProgress) {
      process.stdout.write(".");
    }

    // No match yet, wait and retry
    await sleep(interval);
  }

  if (showProgress) {
    process.stdout.write("\n"); // End progress line
  }
  throw new Error(`Timeout waiting for email after ${options.timeout ?? DEFAULT_WAIT_TIMEOUT_S}s. Use -T to increase timeout.`);
}

/**
 * Get the latest email from a list
 */
export function getLatestEmail(emails: EmailSummary[]): EmailSummary | null {
  if (emails.length === 0) return null;

  // Sort by date descending (most recent first)
  const sorted = [...emails].sort((a, b) => {
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  return sorted[0];
}
