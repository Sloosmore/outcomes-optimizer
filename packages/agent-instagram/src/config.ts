/**
 * Central configuration constants for agent-instagram
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

/** Default polling interval in milliseconds for upload status checks */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Default status check timeout in seconds */
export const DEFAULT_STATUS_TIMEOUT_S = 300;

/**
 * File system permissions
 */

/** File mode: owner read/write only (0o600) - protects credentials */
export const FILE_MODE = 0o600;

/** Directory mode: owner read/write/execute only (0o700) */
export const DIR_MODE = 0o700;

/**
 * Instagram Graph API
 */

/** Base URL for Instagram Graph API
 *  Use graph.facebook.com for Facebook User Tokens (EAA prefix, from Facebook Login)
 *  Use graph.instagram.com for Instagram User Tokens (IGAAL prefix, from Instagram Business Login)
 */
export const GRAPH_API_BASE =
  process.env.INSTAGRAM_API_HOST
    ? `${process.env.INSTAGRAM_API_HOST}/v21.0`
    : "https://graph.facebook.com/v21.0";

/** Maximum caption length for Instagram posts */
export const MAX_CAPTION_LENGTH = 2200;
