import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionState } from "../adapters/types.js";
export type { SessionState } from "../adapters/types.js";
import { FILE_MODE, DIR_MODE } from "../config.js";

/**
 * Get the state directory path
 *
 * Priority:
 * 1. AGENT_INSTAGRAM_STATE_DIR env var (must be absolute)
 * 2. ~/.agent-instagram/
 */
export function getStateDir(): string {
  if (process.env.AGENT_INSTAGRAM_STATE_DIR) {
    const envPath = process.env.AGENT_INSTAGRAM_STATE_DIR;
    if (!envPath.startsWith("/")) {
      throw new Error(
        `AGENT_INSTAGRAM_STATE_DIR must be an absolute path, got: "${envPath}"`
      );
    }
    return envPath;
  }

  return join(homedir(), ".agent-instagram");
}

/**
 * Get the path to the current session state file
 */
export function getStatePath(): string {
  return join(getStateDir(), "session.json");
}

/**
 * Ensure the state directory exists with secure permissions
 */
async function ensureStateDir(): Promise<void> {
  const dir = getStateDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Load the current session state
 * Returns null if no session exists or state is corrupted
 */
export async function loadSession(): Promise<SessionState | null> {
  const path = getStatePath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);
    if (!isValidState(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validate that an object has required SessionState fields
 */
function isValidState(obj: unknown): obj is SessionState {
  if (!obj || typeof obj !== "object") return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s.accessToken === "string" &&
    typeof s.businessAccountId === "string" &&
    typeof s.username === "string" &&
    typeof s.created === "string" &&
    typeof s.adapter === "string"
  );
}

/**
 * Save session state with secure file permissions (0o600)
 */
export async function saveSession(state: SessionState): Promise<void> {
  await ensureStateDir();
  const path = getStatePath();
  await writeFile(path, JSON.stringify(state, null, 2), {
    encoding: "utf-8",
    mode: FILE_MODE,
  });
}

/**
 * Clear the current session state
 */
export async function clearSession(): Promise<void> {
  const path = getStatePath();
  if (existsSync(path)) {
    await rm(path);
  }
}
