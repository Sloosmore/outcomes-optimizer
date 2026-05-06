/**
 * Adapter registration
 */

import { adapterRegistry } from "./registry.js";
import { YouTubeAdapterImpl } from "./youtube.js";

// Register YouTube adapter
adapterRegistry.register("youtube", {
  adapter: new YouTubeAdapterImpl(),
  description: "YouTube via OAuth for Shorts automation",
  requiresAuth: true,
  ciCompatible: false,
});

// Re-export registry for commands to use
export { adapterRegistry } from "./registry.js";
export type { AdapterInfo } from "./registry.js";

// Re-export types
export type {
  YouTubeAdapter,
  YouTubeSession,
  OAuthCredentials,
  ChannelInfo,
  VideoUpload,
  UploadResult,
  VideoMetrics,
  VideoSummary,
  QuotaStatus,
  ListOptions,
} from "./types.js";
