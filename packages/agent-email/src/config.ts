/**
 * Central configuration constants for agent-email
 *
 * All configurable values should be defined here for easy discovery and modification.
 */

/**
 * Network configuration
 */

/** Default request timeout in milliseconds */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum response body size in bytes (10MB) */
export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

/**
 * Polling configuration
 */

/** Default polling interval in milliseconds */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Default wait timeout in seconds */
export const DEFAULT_WAIT_TIMEOUT_S = 60;

/**
 * File system permissions
 */

/** File mode: owner read/write only (0o600) - protects credentials */
export const FILE_MODE = 0o600;

/** Directory mode: owner read/write/execute only (0o700) */
export const DIR_MODE = 0o700;

/**
 * Text processing limits
 */

/** Maximum text length for regex matching (ReDoS protection) */
export const MAX_REGEX_INPUT_LENGTH = 100_000;
