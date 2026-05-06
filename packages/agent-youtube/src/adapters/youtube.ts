/**
 * YouTube API adapter
 *
 * Note: google.options({ fetchImplementation: globalThis.fetch }) is called at
 * module load so that gaxios (the HTTP client used by googleapis) routes all
 * requests through globalThis.fetch. When the credential-proxy interceptor is
 * installed, this means googleapis requests are transparently proxied and
 * credentials are injected by the sidecar — the agent process never sees raw
 * tokens.
 */

import { createReadStream, statSync } from "node:fs";
import { google, youtube_v3 } from "googleapis";

// Route all googleapis/gaxios HTTP calls through globalThis.fetch so the
// credential-proxy interceptor (when installed) can inject credentials.
// This must be called before any google.* client is constructed.
//
// Wrap globalThis.fetch to add `duplex: 'half'` when a streaming body is
// present. Node.js 18+ native fetch requires this option for requests that
// send a ReadableStream or Node.js Readable as the body, but gaxios does not
// set it — causing "duplex option is required when sending a body" errors.
const _originalFetch = globalThis.fetch;
const fetchWithDuplex: typeof globalThis.fetch = (input, init?) => {
  if (init?.body != null) {
    return _originalFetch(input, { ...init, duplex: "half" } as RequestInit);
  }
  return _originalFetch(input, init);
};
google.options({ fetchImplementation: fetchWithDuplex });
import type {
  YouTubeAdapter,
  YouTubeSession,
  ChannelInfo,
  VideoUpload,
  UploadResult,
  VideoMetrics,
  VideoSummary,
  ListOptions,
  QuotaStatus,
  OAuthCredentials,
} from "./types.js";
import { runOAuthFlow, createOAuth2Client } from "./oauth.js";
import {
  loadCredentials,
  hasCredentials as checkHasCredentials,
} from "../state/credentials.js";
import { saveChannel, loadChannel } from "../state/channel.js";
import {
  recordQuotaUsage,
  getQuotaStatus,
  hasQuotaFor,
} from "../state/quota.js";
import {
  QUOTA_COSTS,
  DEFAULT_PRIVACY,
  DEFAULT_CATEGORY_ID,
  DEFAULT_LIST_LIMIT,
  SHORTS_HASHTAG,
} from "../config.js";

/**
 * YouTube session implementation
 */
class YouTubeSessionImpl implements YouTubeSession {
  readonly channel: ChannelInfo;
  private youtube: youtube_v3.Youtube;

  constructor(youtube: youtube_v3.Youtube, channel: ChannelInfo) {
    this.youtube = youtube;
    this.channel = channel;
  }

  async delete(videoId: string): Promise<void> {
    // Check quota (delete costs 50 units)
    if (!(await hasQuotaFor("videos.delete"))) {
      const status = await getQuotaStatus();
      throw new Error(
        `Quota exceeded. Resets at ${status.resetsAt}. ` +
          `Used: ${status.used}/${status.limit}`
      );
    }

    await this.youtube.videos.delete({
      id: videoId,
    });

    await recordQuotaUsage("videos.delete");
  }

  async upload(video: VideoUpload): Promise<UploadResult> {
    // Check quota
    if (!(await hasQuotaFor("videos.insert"))) {
      const status = await getQuotaStatus();
      throw new Error(
        `Quota exceeded. Resets at ${status.resetsAt}. ` +
          `Used: ${status.used}/${status.limit}`
      );
    }

    // Validate file exists and is a valid video file
    try {
      const stats = statSync(video.file);
      if (!stats.isFile()) {
        throw new Error(`Not a file: ${video.file}`);
      }
      if (stats.size === 0) {
        throw new Error(`Empty file: ${video.file}`);
      }
    } catch (err) {
      // Re-throw our own errors
      if (err instanceof Error && err.message.includes(video.file)) {
        throw err;
      }
      // Handle system errors with appropriate messages
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new Error(`Video file not found: ${video.file}`);
      } else if (nodeErr.code === "EACCES" || nodeErr.code === "EPERM") {
        throw new Error(`Permission denied: ${video.file}`);
      }
      throw new Error(`Cannot access video file: ${video.file}`);
    }

    // Ensure #Shorts in title
    let title = video.title;
    if (!title.includes(SHORTS_HASHTAG)) {
      title = `${title} ${SHORTS_HASHTAG}`;
    }

    // Upload video
    const response = await this.youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title,
          description: video.description || "",
          tags: video.tags || [],
          categoryId: video.categoryId || DEFAULT_CATEGORY_ID,
        },
        status: {
          privacyStatus: video.privacy || DEFAULT_PRIVACY,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: createReadStream(video.file),
      },
    });

    // Record quota usage
    await recordQuotaUsage("videos.insert");

    const videoId = response.data.id;
    if (!videoId) {
      throw new Error("Upload succeeded but no video ID returned");
    }

    return {
      videoId,
      url: `https://youtube.com/watch?v=${videoId}`,
      shortsUrl: `https://youtube.com/shorts/${videoId}`,
      title,
      publishedAt:
        response.data.snippet?.publishedAt || new Date().toISOString(),
      quotaUsed: QUOTA_COSTS["videos.insert"],
    };
  }

  async getMetrics(videoId: string): Promise<VideoMetrics> {
    // Check quota
    if (!(await hasQuotaFor("videos.list"))) {
      throw new Error("Quota exceeded for metrics lookup");
    }

    const response = await this.youtube.videos.list({
      part: ["snippet", "statistics"],
      id: [videoId],
    });

    await recordQuotaUsage("videos.list");

    const video = response.data.items?.[0];
    if (!video) {
      throw new Error(`Video not found: ${videoId}`);
    }

    const stats = video.statistics || {};
    const snippet = video.snippet || {};

    const publishedAt = snippet.publishedAt || new Date().toISOString();
    const ageMs = Date.now() - new Date(publishedAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    const views = parseInt(stats.viewCount || "0", 10);
    const likes = parseInt(stats.likeCount || "0", 10);
    const comments = parseInt(stats.commentCount || "0", 10);

    // Handle negative ageHours (future publishedAt due to clock skew)
    const safeAgeHours = Math.max(0, ageHours);

    return {
      videoId,
      title: snippet.title || "",
      publishedAt,
      views,
      likes,
      comments,
      ageHours: Math.round(safeAgeHours * 10) / 10,
      viewsPerHour: safeAgeHours > 0 ? Math.round((views / safeAgeHours) * 10) / 10 : 0,
      engagementRate:
        views > 0 ? Math.round(((likes + comments) / views) * 1000) / 10 : 0,
    };
  }

  async listVideos(options?: ListOptions): Promise<VideoSummary[]> {
    const limit = options?.limit || DEFAULT_LIST_LIMIT;

    // Check quota
    if (!(await hasQuotaFor("playlistItems.list"))) {
      throw new Error("Quota exceeded for listing videos");
    }

    // Get videos from uploads playlist (much cheaper than search)
    const response = await this.youtube.playlistItems.list({
      part: ["snippet"],
      playlistId: this.channel.uploadsPlaylistId,
      maxResults: Math.min(limit, 50),
    });

    await recordQuotaUsage("playlistItems.list");

    const items = response.data.items || [];

    // Filter by time if specified
    let filtered = items;
    if (options?.since) {
      const sinceMs = parseDuration(options.since);
      const cutoff = Date.now() - sinceMs;
      filtered = items.filter((item) => {
        const publishedAt = item.snippet?.publishedAt;
        return publishedAt && new Date(publishedAt).getTime() >= cutoff;
      });
    }

    // Get statistics for the videos (batch request)
    const videoIds = filtered
      .map((item) => item.snippet?.resourceId?.videoId)
      .filter((id): id is string => !!id);

    if (videoIds.length === 0) {
      return [];
    }

    // Check quota for stats lookup
    if (!(await hasQuotaFor("videos.list"))) {
      // Return without stats if no quota
      return filtered.map((item) => ({
        videoId: item.snippet?.resourceId?.videoId || "",
        title: item.snippet?.title || "",
        publishedAt: item.snippet?.publishedAt || "",
        views: 0,
        thumbnailUrl:
          item.snippet?.thumbnails?.default?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          "",
      }));
    }

    const statsResponse = await this.youtube.videos.list({
      part: ["statistics"],
      id: videoIds,
    });

    await recordQuotaUsage("videos.list");

    const statsMap = new Map<string, number>();
    for (const video of statsResponse.data.items || []) {
      if (video.id && video.statistics?.viewCount) {
        statsMap.set(video.id, parseInt(video.statistics.viewCount, 10));
      }
    }

    return filtered.map((item) => {
      const videoId = item.snippet?.resourceId?.videoId || "";
      return {
        videoId,
        title: item.snippet?.title || "",
        publishedAt: item.snippet?.publishedAt || "",
        views: statsMap.get(videoId) || 0,
        thumbnailUrl:
          item.snippet?.thumbnails?.default?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          "",
      };
    });
  }

  async getQuota(): Promise<QuotaStatus> {
    return await getQuotaStatus();
  }
}

/**
 * Parse duration string to milliseconds
 * Caps at 1 year to prevent overflow issues
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(h|d|w)$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use: 24h, 7d, 1w`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  // Cap at reasonable maximums to prevent overflow
  const MAX_HOURS = 8760; // 1 year
  const MAX_DAYS = 365;
  const MAX_WEEKS = 52;

  let ms: number;
  switch (unit) {
    case "h":
      if (value > MAX_HOURS) {
        throw new Error(`Duration too large: ${duration}. Max: ${MAX_HOURS}h`);
      }
      ms = value * 60 * 60 * 1000;
      break;
    case "d":
      if (value > MAX_DAYS) {
        throw new Error(`Duration too large: ${duration}. Max: ${MAX_DAYS}d`);
      }
      ms = value * 24 * 60 * 60 * 1000;
      break;
    case "w":
      if (value > MAX_WEEKS) {
        throw new Error(`Duration too large: ${duration}. Max: ${MAX_WEEKS}w`);
      }
      ms = value * 7 * 24 * 60 * 60 * 1000;
      break;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }

  return ms;
}

/**
 * Fetch channel info from API
 */
async function fetchChannelInfo(
  youtube: youtube_v3.Youtube
): Promise<ChannelInfo> {
  const response = await youtube.channels.list({
    part: ["snippet", "contentDetails"],
    mine: true,
  });

  await recordQuotaUsage("channels.list");

  const channel = response.data.items?.[0];
  if (!channel || !channel.id) {
    throw new Error("Could not fetch channel info");
  }

  const uploadsPlaylistId =
    channel.contentDetails?.relatedPlaylists?.uploads || "";

  if (!uploadsPlaylistId) {
    throw new Error("Could not find uploads playlist");
  }

  return {
    id: channel.id,
    name: channel.snippet?.title || "Unknown",
    uploadsPlaylistId,
    customUrl: channel.snippet?.customUrl || undefined,
  };
}

/**
 * YouTube adapter implementation
 */
export class YouTubeAdapterImpl implements YouTubeAdapter {
  async authenticate(): Promise<YouTubeSession> {
    const credentials = await runOAuthFlow();
    return this.createSession(credentials);
  }

  async restoreSession(): Promise<YouTubeSession> {
    const credentials = await loadCredentials();
    if (!credentials) {
      throw new Error(
        "Not authenticated. Run: agent-youtube auth"
      );
    }
    return this.createSession(credentials);
  }

  hasCredentials(): boolean {
    return checkHasCredentials();
  }

  private async createSession(
    credentials: OAuthCredentials
  ): Promise<YouTubeSession> {
    const oauth2Client = await createOAuth2Client(credentials);
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });

    // Try to load cached channel info
    let channel = await loadChannel();

    // Fetch if not cached
    if (!channel) {
      channel = await fetchChannelInfo(youtube);
      await saveChannel(channel);
    }

    return new YouTubeSessionImpl(youtube, channel);
  }
}

// Note: Adapter is registered in ./index.ts via the registry pattern
// Commands should use: adapterRegistry.get("youtube") instead of direct import
