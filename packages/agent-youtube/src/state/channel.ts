/**
 * Channel info cache
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, CHANNEL_FILE } from "../config.js";
import type { ChannelInfo } from "../adapters/types.js";

const CHANNEL_PATH = join(STATE_DIR, CHANNEL_FILE);

/**
 * Ensure state directory exists
 */
async function ensureStateDir(): Promise<void> {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Save channel info
 */
export async function saveChannel(channel: ChannelInfo): Promise<void> {
  await ensureStateDir();
  await writeFile(CHANNEL_PATH, JSON.stringify(channel, null, 2), {
    mode: 0o600,
  });
}

/**
 * Load channel info
 */
export async function loadChannel(): Promise<ChannelInfo | null> {
  if (!existsSync(CHANNEL_PATH)) {
    return null;
  }

  try {
    const data = await readFile(CHANNEL_PATH, "utf-8");
    return JSON.parse(data) as ChannelInfo;
  } catch (err) {
    // Log error for debugging - corrupted files should be noticed
    console.error(
      `Warning: Failed to load channel cache: ${err instanceof Error ? err.message : "unknown error"}`
    );
    return null;
  }
}
