/**
 * Quota tracking for YouTube API
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, QUOTA_FILE, DAILY_QUOTA_LIMIT, QUOTA_COSTS } from "../config.js";
import type { QuotaStatus } from "../adapters/types.js";

const QUOTA_PATH = join(STATE_DIR, QUOTA_FILE);

interface QuotaOperation {
  type: keyof typeof QUOTA_COSTS;
  cost: number;
  at: string;
}

interface QuotaState {
  date: string;
  used: number;
  operations: QuotaOperation[];
}

/**
 * Get today's date in YYYY-MM-DD format (Pacific Time)
 */
function getTodayPT(): string {
  const now = new Date();
  // Convert to Pacific Time
  const pt = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  return pt.toISOString().slice(0, 10);
}

/**
 * Get reset time (midnight PT)
 * Handles DST correctly - PT is UTC-8 (PST) or UTC-7 (PDT)
 */
function getResetTime(): string {
  // Get tomorrow's date in PT
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Create a date string for midnight tomorrow in PT
  const tomorrowPT = new Date(
    tomorrow.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  const tomorrowDateStr = tomorrowPT.toISOString().slice(0, 10);

  // Create midnight PT for tomorrow and convert to UTC
  // This correctly handles DST by using the timezone
  const midnightPT = new Date(`${tomorrowDateStr}T00:00:00`);
  const ptOffset = getPTOffset(midnightPT);
  const midnightUTC = new Date(midnightPT.getTime() + ptOffset * 60 * 60 * 1000);

  return midnightUTC.toISOString();
}

/**
 * Get the UTC offset for Pacific Time (handles DST)
 * Returns 8 for PST (winter) or 7 for PDT (summer)
 */
function getPTOffset(date: Date): number {
  // Create the same date in both UTC and PT, then compare
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const pt = new Date(date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return (utc.getTime() - pt.getTime()) / (60 * 60 * 1000);
}

/**
 * Ensure state directory exists
 */
async function ensureStateDir(): Promise<void> {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load quota state, resetting if it's a new day
 */
async function loadQuotaState(): Promise<QuotaState> {
  const today = getTodayPT();

  if (!existsSync(QUOTA_PATH)) {
    return { date: today, used: 0, operations: [] };
  }

  try {
    const data = await readFile(QUOTA_PATH, "utf-8");
    const state = JSON.parse(data) as QuotaState;

    // Reset if it's a new day
    if (state.date !== today) {
      return { date: today, used: 0, operations: [] };
    }

    return state;
  } catch (err) {
    // Log error for debugging - corrupted state should be noticed
    console.error(
      `Warning: Failed to load quota state: ${err instanceof Error ? err.message : "unknown error"}`
    );
    return { date: today, used: 0, operations: [] };
  }
}

/**
 * Save quota state
 */
async function saveQuotaState(state: QuotaState): Promise<void> {
  await ensureStateDir();
  await writeFile(QUOTA_PATH, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

/**
 * Record a quota-consuming operation
 */
export async function recordQuotaUsage(
  operationType: keyof typeof QUOTA_COSTS
): Promise<void> {
  const state = await loadQuotaState();
  const cost = QUOTA_COSTS[operationType];

  state.used += cost;
  state.operations.push({
    type: operationType,
    cost,
    at: new Date().toISOString(),
  });

  await saveQuotaState(state);
}

/**
 * Get current quota status
 */
export async function getQuotaStatus(): Promise<QuotaStatus> {
  const state = await loadQuotaState();
  const remaining = Math.max(0, DAILY_QUOTA_LIMIT - state.used);

  return {
    date: state.date,
    used: state.used,
    remaining,
    limit: DAILY_QUOTA_LIMIT,
    uploadsRemaining: Math.floor(remaining / QUOTA_COSTS["videos.insert"]),
    resetsAt: getResetTime(),
  };
}

/**
 * Check if we have enough quota for an operation
 */
export async function hasQuotaFor(
  operationType: keyof typeof QUOTA_COSTS
): Promise<boolean> {
  const status = await getQuotaStatus();
  const cost = QUOTA_COSTS[operationType];
  return status.remaining >= cost;
}
