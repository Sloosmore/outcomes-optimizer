/**
 * Central configuration constants for agent-media
 *
 * All configurable values should be defined here for easy discovery and modification.
 */

/**
 * Modality types
 */
export type Modality = "image" | "video" | "audio";

/**
 * Network configuration
 */

/** Default request timeout in milliseconds (1 minute for media APIs) */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Image request timeout in milliseconds (2 minutes) */
export const IMAGE_TIMEOUT_MS = 120_000;

/** Video request timeout in milliseconds (10 minutes for generation) */
export const VIDEO_TIMEOUT_MS = 600_000;

/** Audio request timeout in milliseconds (5 minutes) */
export const AUDIO_TIMEOUT_MS = 300_000;

/** Maximum response body size in bytes (100MB for video) */
export const MAX_RESPONSE_SIZE = 100 * 1024 * 1024;

/**
 * Polling configuration (for video)
 */

/** Default polling interval in milliseconds */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Default video generation timeout in seconds */
export const DEFAULT_VIDEO_TIMEOUT_S = 600;

/**
 * File system permissions
 */

/** File mode for generated media: owner read/write, group/others read */
export const FILE_MODE = 0o644;

/** File mode for state files: owner read/write only (protects any keys) */
export const STATE_FILE_MODE = 0o600;

/** Directory mode: owner read/write/execute only */
export const DIR_MODE = 0o700;

/**
 * Cost configuration
 */

/** Default maximum cost per command in USD */
export const DEFAULT_MAX_COST_USD = 1.0;

/**
 * Image defaults
 */

/** Default image size */
export const DEFAULT_IMAGE_SIZE = "1024x1024";

/** Default image count */
export const DEFAULT_IMAGE_COUNT = 1;

/** Default concurrency for bulk operations */
export const DEFAULT_BULK_CONCURRENCY = 3;

/** Maximum concurrency for bulk operations (prevents API rate limiting) */
export const MAX_BULK_CONCURRENCY = 10;

/** Maximum number of prompts in a bulk operation (prevents memory issues) */
export const MAX_BULK_PROMPTS = 100;

/** Default delay between requests in bulk operations (milliseconds) */
export const DEFAULT_BULK_DELAY_MS = 0;

/**
 * Video defaults
 */

/** Default video duration in seconds (must be even for Veo 3.1) */
export const DEFAULT_VIDEO_DURATION_S = 8;

/**
 * Audio defaults
 */

/** Default TTS voice */
export const DEFAULT_VOICE = "alloy";

/** Default audio format */
export const DEFAULT_AUDIO_FORMAT = "mp3";

/**
 * Exit codes
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  PARTIAL_SUCCESS: 1,
  COMPLETE_FAILURE: 2,
  CONFIG_ERROR: 3,
  FILE_ERROR: 4,
  USER_ABORT: 5,
  COST_LIMIT_EXCEEDED: 6,
} as const;

/**
 * Exit codes for the `read --review` command.
 * Distinct from general EXIT_CODES so scripts can branch on verdict.
 *
 *   0  post       — ready to publish
 *   1  edit       — fixable issues, minor changes needed
 *   2  regenerate — fundamental problems, start over
 *   3  error      — unexpected failure during review
 */
export const REVIEW_EXIT_CODES = {
  POST: 0,
  EDIT: 1,
  REGENERATE: 2,
  ERROR: 3,
} as const;

/**
 * Model-specific limits (centralized for consistency)
 */
export const MODEL_LIMITS = {
  /** DALL-E 3 maximum prompt length in characters */
  DALLE3_MAX_PROMPT_LENGTH: 4000,
  /** OpenAI TTS maximum text length in characters */
  OPENAI_TTS_MAX_LENGTH: 4096,
  /** Gemini maximum prompt length in characters */
  GEMINI_MAX_PROMPT_LENGTH: 5000,
} as const;

/**
 * Tolerance for aspect ratio matching (0.1 = 10% tolerance)
 */
export const ASPECT_RATIO_TOLERANCE = 0.1;
