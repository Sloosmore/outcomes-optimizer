import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import type { SessionCredentials } from "../adapters/types.js";
import { FILE_MODE, DIR_MODE } from "../config.js";

/**
 * Validate that a path doesn't escape the workspace via traversal
 * Returns the validated path or throws if invalid
 */
function validateStatePath(basePath: string, relativePath: string): string {
  const resolved = resolve(basePath, relativePath);
  const rel = relative(basePath, resolved);

  // Check for path traversal (escaping workspace)
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(
      `Invalid stateDir: "${relativePath}" escapes workspace. ` +
      `Path must be within workspace directory.`
    );
  }
  return resolved;
}

/**
 * Persistent inbox state
 */
export interface InboxState {
  /** Full email address */
  address: string;
  /** Login portion (before @) */
  login: string;
  /** Domain portion (after @) */
  domain: string;
  /** ISO timestamp when inbox was initialized */
  created: string;
  /** IDs of emails we've already seen (for wait command) */
  seenIds: string[];
  /** Which adapter this inbox uses (dynamic - supports any registered adapter) */
  adapter: string;
  /** Session credentials for restoring the session */
  credentials: SessionCredentials;
}

/**
 * Try to read stateDir from config.yaml if it exists
 * Returns undefined if not found or not configured
 */
function getStateDirFromConfig(): string | undefined {
  const configPath = join(process.cwd(), "config.yaml");
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    // Simple yaml parsing for tools.stateDir - avoid adding yaml dependency
    const match = content.match(/^tools:\s*\n\s+stateDir:\s*(.+)$/m);
    if (match) {
      return match[1].trim();
    }
  } catch {
    // Ignore errors, fall back to default
  }
  return undefined;
}

/**
 * Get the state directory path
 *
 * Priority:
 * 1. AGENT_EMAIL_STATE_DIR env var (explicit override - must be absolute)
 * 2. config.yaml tools.stateDir (workspace config - validated)
 * 3. ./.agent-email (workspace folder)
 */
export function getStateDir(): string {
  const cwd = process.cwd();

  // 1. Env var override (must be absolute path for security)
  if (process.env.AGENT_EMAIL_STATE_DIR) {
    const envPath = process.env.AGENT_EMAIL_STATE_DIR;
    // Only accept absolute paths from env var to prevent confusion
    if (!envPath.startsWith("/")) {
      throw new Error(
        `AGENT_EMAIL_STATE_DIR must be an absolute path, got: "${envPath}"`
      );
    }
    return envPath;
  }

  // 2. Config.yaml (validated to prevent traversal)
  const configStateDir = getStateDirFromConfig();
  if (configStateDir) {
    return validateStatePath(cwd, configStateDir);
  }

  // 3. Default to workspace folder
  return join(cwd, ".agent-email");
}

/**
 * Get the path to the current inbox state file
 */
export function getStatePath(): string {
  return join(getStateDir(), "current.json");
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
 * Load the current inbox state
 * Returns null if no inbox is initialized or state is corrupted
 */
export async function loadState(): Promise<InboxState | null> {
  const path = getStatePath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);
    if (!isValidState(parsed)) {
      // State file is corrupted or has invalid schema
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validate that an object has required InboxState fields
 */
function isValidState(obj: unknown): obj is InboxState {
  if (!obj || typeof obj !== "object") return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s.address === "string" &&
    typeof s.login === "string" &&
    typeof s.domain === "string" &&
    typeof s.created === "string" &&
    Array.isArray(s.seenIds) &&
    s.seenIds.every((id) => typeof id === "string") &&
    typeof s.adapter === "string"
  );
}

/**
 * Save inbox state with secure file permissions (0o600)
 */
export async function saveState(state: InboxState): Promise<void> {
  await ensureStateDir();
  const path = getStatePath();
  await writeFile(path, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: FILE_MODE });
}

/**
 * Clear the current inbox state
 */
export async function clearState(): Promise<void> {
  const path = getStatePath();
  if (existsSync(path)) {
    await rm(path);
  }
}

/**
 * Mark email IDs as seen
 */
export async function markSeen(ids: string[]): Promise<void> {
  const state = await loadState();
  if (!state) {
    throw new Error("No inbox initialized. Run 'throwmail init' first.");
  }
  const newIds = ids.filter((id) => !state.seenIds.includes(id));
  if (newIds.length > 0) {
    state.seenIds = [...state.seenIds, ...newIds];
    await saveState(state);
  }
}

/**
 * Get unseen email IDs from a list
 */
export function filterUnseen(state: InboxState, ids: string[]): string[] {
  return ids.filter((id) => !state.seenIds.includes(id));
}
