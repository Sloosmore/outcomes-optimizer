/**
 * agent-youtube - CLI for YouTube Shorts automation
 *
 * Usage:
 *   agent-youtube auth              # Authenticate with YouTube
 *   agent-youtube upload <file>     # Upload a Short
 *   agent-youtube metrics <id>      # Get video metrics
 *   agent-youtube list              # List recent uploads
 *   agent-youtube quota             # Check remaining quota
 *   agent-youtube whoami            # Show authenticated channel
 */

export { adapterRegistry } from "./adapters/index.js";
export { YouTubeAdapterImpl } from "./adapters/youtube.js";
export { exchangeRefreshToken } from "./adapters/token-exchange.js";
export type {
  YouTubeAdapter,
  YouTubeSession,
  ChannelInfo,
  VideoUpload,
  UploadResult,
  VideoMetrics,
  VideoSummary,
  QuotaStatus,
  ListOptions,
} from "./adapters/types.js";
