import type {
  InstagramAdapter,
  InstagramSession,
  InstagramCredentials,
  SessionState,
  PhotoPostOptions,
  VideoPostOptions,
  ReelPostOptions,
  PostResult,
  PostStatus,
  ProfileInfo,
  MediaInsights,
} from "./types.js";
import { getProxyFetch } from "../utils/fetch.js";
import { safeJsonParse } from "../utils/json.js";
import { GRAPH_API_BASE, DEFAULT_POLL_INTERVAL_MS, DEFAULT_STATUS_TIMEOUT_S } from "../config.js";

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Instagram Graph API session
 *
 * Uses the Instagram Graph API (via Meta Business Suite) for all operations.
 * Requires a valid access token and business account ID.
 */
class InstagramApiSession implements InstagramSession {
  readonly accountId: string;
  readonly username: string;
  readonly credentials: SessionState;

  private accessToken: string;

  constructor(credentials: SessionState) {
    this.accountId = credentials.businessAccountId;
    this.username = credentials.username;
    this.accessToken = credentials.accessToken;
    this.credentials = credentials;
  }

  /**
   * Make a Graph API request
   */
  private async graphRequest<T>(
    path: string,
    method: "GET" | "POST" = "GET",
    params?: Record<string, string>
  ): Promise<T> {
    const url = new URL(`${GRAPH_API_BASE}${path}`);
    const proxyFetch = getProxyFetch();

    if (method === "GET") {
      url.searchParams.set("access_token", this.accessToken);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value);
        }
      }
    }

    const init: RequestInit = { method };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      const body = new URLSearchParams(params || {});
      body.set("access_token", this.accessToken);
      init.body = body;
    }

    const res = await proxyFetch(url.toString(), init);

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      let errorMessage = `Instagram API error: ${res.status} ${res.statusText}`;
      try {
        const errorJson = JSON.parse(errorBody);
        if (errorJson.error?.message) {
          errorMessage = `Instagram API error: ${errorJson.error.message}`;
        }
      } catch {
        if (errorBody) {
          errorMessage += ` - ${errorBody.slice(0, 200)}`;
        }
      }
      throw new Error(errorMessage);
    }

    return safeJsonParse<T>(res, `Graph API ${method} ${path}`);
  }

  /**
   * Create a media container and wait for it to be ready
   */
  private async createContainer(
    params: Record<string, string>
  ): Promise<string> {
    const result = await this.graphRequest<{ id: string }>(
      `/${encodeURIComponent(this.accountId)}/media`,
      "POST",
      params
    );

    if (!result.id) {
      throw new Error("Failed to create media container: no ID returned");
    }

    return result.id;
  }

  /**
   * Publish a media container
   */
  private async publishContainer(containerId: string): Promise<string> {
    const result = await this.graphRequest<{ id: string }>(
      `/${encodeURIComponent(this.accountId)}/media_publish`,
      "POST",
      { creation_id: containerId }
    );

    if (!result.id) {
      throw new Error("Failed to publish media: no ID returned");
    }

    return result.id;
  }

  /**
   * Wait for a media container to finish processing
   */
  private async waitForContainer(
    containerId: string,
    timeoutS: number = DEFAULT_STATUS_TIMEOUT_S
  ): Promise<void> {
    const startTime = Date.now();
    const timeoutMs = timeoutS * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getPostStatus(containerId);

      if (status.status === "FINISHED" || status.status === "PUBLISHED") {
        return;
      }

      if (status.status === "ERROR") {
        throw new Error(
          `Media processing failed: ${status.errorMessage || status.statusCode || "unknown error"}`
        );
      }

      if (status.status === "EXPIRED") {
        throw new Error("Media container expired before publishing");
      }

      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Timeout waiting for media processing after ${timeoutS}s`
    );
  }

  async postPhoto(options: PhotoPostOptions): Promise<PostResult> {
    const params: Record<string, string> = {
      image_url: options.imageUrl,
    };
    if (options.caption) {
      params.caption = options.caption;
    }

    const containerId = await this.createContainer(params);

    // Photos are usually ready immediately, but check anyway
    await this.waitForContainer(containerId);

    const postId = await this.publishContainer(containerId);

    return {
      id: postId,
      status: "published",
      message: "Photo published successfully",
    };
  }

  async postVideo(options: VideoPostOptions): Promise<PostResult> {
    const params: Record<string, string> = {
      media_type: "VIDEO",
      video_url: options.videoUrl,
    };
    if (options.caption) {
      params.caption = options.caption;
    }
    if (options.coverUrl) {
      params.cover_url = options.coverUrl;
    }

    const containerId = await this.createContainer(params);

    // Videos need processing time
    await this.waitForContainer(containerId);

    const postId = await this.publishContainer(containerId);

    return {
      id: postId,
      status: "published",
      message: "Video published successfully",
    };
  }

  async postReel(options: ReelPostOptions): Promise<PostResult> {
    const params: Record<string, string> = {
      media_type: "REELS",
      video_url: options.videoUrl,
    };
    if (options.caption) {
      params.caption = options.caption;
    }
    if (options.coverUrl) {
      params.cover_url = options.coverUrl;
    }
    if (options.shareToFeed !== undefined) {
      params.share_to_feed = String(options.shareToFeed);
    }

    const containerId = await this.createContainer(params);

    // Reels need processing time
    await this.waitForContainer(containerId);

    const postId = await this.publishContainer(containerId);

    return {
      id: postId,
      status: "published",
      message: "Reel published successfully",
    };
  }

  async getPostStatus(postId: string): Promise<PostStatus> {
    interface StatusResponse {
      id: string;
      status_code?: string;
      status?: string;
    }

    // Note: only request 'id' and 'status_code' — 'error_message' is NOT a
    // valid field on media containers and causes a GraphMethodException.
    const data = await this.graphRequest<StatusResponse>(
      `/${encodeURIComponent(postId)}`,
      "GET",
      { fields: "id,status_code" }
    );

    const statusCode = data.status_code || "UNKNOWN";

    // Map Graph API status codes to our status enum
    let status: PostStatus["status"];
    switch (statusCode) {
      case "FINISHED":
        status = "FINISHED";
        break;
      case "IN_PROGRESS":
        status = "IN_PROGRESS";
        break;
      case "PUBLISHED":
        status = "PUBLISHED";
        break;
      case "EXPIRED":
        status = "EXPIRED";
        break;
      case "ERROR":
        status = "ERROR";
        break;
      default:
        status = "IN_PROGRESS";
    }

    return {
      id: data.id,
      status,
      statusCode,
      errorMessage: undefined,
    };
  }

  async getProfile(): Promise<ProfileInfo> {
    interface ProfileResponse {
      id: string;
      username: string;
      name: string;
      biography: string;
      followers_count: number;
      follows_count: number;
      media_count: number;
      profile_picture_url: string;
      website: string;
    }

    const data = await this.graphRequest<ProfileResponse>(
      `/${encodeURIComponent(this.accountId)}`,
      "GET",
      {
        fields:
          "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website",
      }
    );

    return {
      username: data.username || this.username,
      name: data.name || "",
      biography: data.biography || "",
      followersCount: data.followers_count || 0,
      followsCount: data.follows_count || 0,
      mediaCount: data.media_count || 0,
      profilePictureUrl: data.profile_picture_url || "",
      website: data.website || "",
    };
  }

  async getMediaInsights(mediaId: string): Promise<MediaInsights> {
    if (!mediaId || !mediaId.trim()) {
      throw new Error("Media ID is required");
    }

    interface InsightValue {
      value: number;
    }
    interface InsightItem {
      name: string;
      values: InsightValue[];
    }
    interface InsightsResponse {
      data: InsightItem[];
    }
    interface MediaTypeResponse {
      media_type: string;
    }

    // Fetch media type first — video_views is only valid for VIDEO/REELS
    const mediaInfo = await this.graphRequest<MediaTypeResponse>(
      `/${encodeURIComponent(mediaId)}`,
      "GET",
      { fields: "media_type" }
    );
    const mediaType = mediaInfo.media_type || "";
    const isVideo = mediaType === "VIDEO" || mediaType === "REELS";

    // Note: 'impressions' was deprecated in Graph API v22.0+ — use 'reach' instead.
    const metrics = ["reach", "saved", "likes", "comments", "shares"];
    if (isVideo) {
      metrics.push("video_views");
    }

    const data = await this.graphRequest<InsightsResponse>(
      `/${encodeURIComponent(mediaId)}/insights`,
      "GET",
      { metric: metrics.join(",") }
    );

    const metricMap: Record<string, number> = {};
    for (const item of data.data || []) {
      metricMap[item.name] = item.values?.[0]?.value ?? 0;
    }

    return {
      impressions: metricMap["impressions"] ?? 0,
      reach: metricMap["reach"] ?? 0,
      videoViews: isVideo ? (metricMap["video_views"] ?? 0) : undefined,
      saved: metricMap["saved"] ?? 0,
      likes: metricMap["likes"] ?? 0,
      comments: metricMap["comments"] ?? 0,
      shares: metricMap["shares"] ?? 0,
    };
  }
}

/**
 * Instagram Graph API adapter
 *
 * Creates sessions using Meta Business Suite access tokens.
 * Requires INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID.
 */
export class InstagramApiAdapter implements InstagramAdapter {
  readonly name = "instagram-api";

  async createSession(credentials: InstagramCredentials): Promise<InstagramSession> {
    const { accessToken, businessAccountId } = credentials;

    if (!accessToken) {
      throw new Error(
        "Instagram API adapter requires an access token. " +
        "Set INSTAGRAM_ACCESS_TOKEN or use --token."
      );
    }

    if (!businessAccountId) {
      throw new Error(
        "Instagram API adapter requires a business account ID. " +
        "Set INSTAGRAM_BUSINESS_ACCOUNT_ID."
      );
    }

    // Validate the token by fetching profile info
    const sessionState: SessionState = {
      accessToken,
      businessAccountId,
      username: "",
      created: new Date().toISOString(),
      adapter: this.name,
    };

    const session = new InstagramApiSession(sessionState);

    // Fetch username to validate credentials
    const profile = await session.getProfile();

    // Update session state with actual username
    const updatedState: SessionState = {
      ...sessionState,
      username: profile.username,
    };

    return new InstagramApiSession(updatedState);
  }

  restoreSession(savedState: SessionState): InstagramSession {
    return new InstagramApiSession(savedState);
  }
}
