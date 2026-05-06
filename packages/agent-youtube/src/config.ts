/**
 * Configuration constants for agent-youtube
 */

// YouTube API
export const YOUTUBE_API_VERSION = "v3";
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube", // Full access (upload, delete, update)
  "https://www.googleapis.com/auth/youtube.readonly",
];

// Quota
export const DAILY_QUOTA_LIMIT = 10000;
export const QUOTA_COSTS = {
  "videos.insert": 100,
  "videos.delete": 50,
  "videos.list": 1,
  "channels.list": 1,
  "playlistItems.list": 1,
  "search.list": 100,
} as const;

// Shorts requirements
export const SHORTS_MAX_DURATION_SECONDS = 60;
export const SHORTS_ASPECT_RATIO = "9:16";
export const SHORTS_HASHTAG = "#Shorts";

// OAuth
export const OAUTH_REDIRECT_PORT = 8085;
export const OAUTH_REDIRECT_PATH = "/callback";
export const OAUTH_TIMEOUT_MS = 300000; // 5 minutes to complete auth

// State directory
export const STATE_DIR =
  process.env.AGENT_YOUTUBE_STATE_DIR ||
  `${process.env.HOME}/.agent-youtube`;

// File paths
export const CREDENTIALS_FILE = "credentials.json";
export const CHANNEL_FILE = "channel.json";
export const QUOTA_FILE = "quota.json";
export const UPLOADS_FILE = "uploads.json";

// Client secrets
export const CLIENT_SECRETS_PATH =
  process.env.YOUTUBE_CLIENT_SECRETS_PATH ||
  `${STATE_DIR}/client_secrets.json`;

// Defaults
export const DEFAULT_PRIVACY = "public" as const;
export const DEFAULT_CATEGORY_ID = "22"; // People & Blogs
export const DEFAULT_LIST_LIMIT = 10;

// Exit codes
export const EXIT_CODES = {
  SUCCESS: 0,
  AUTH_REQUIRED: 1,
  API_ERROR: 2,
  QUOTA_EXCEEDED: 3,
  INVALID_INPUT: 4,
  CONFIG_ERROR: 5,
  PARTIAL_SUCCESS: 6,
} as const;
