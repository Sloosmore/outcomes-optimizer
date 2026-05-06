/**
 * Core types for YouTube adapter
 */

export interface OAuthCredentials {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  uploadsPlaylistId: string;
  customUrl?: string;
}

export interface VideoUpload {
  file: string;
  title: string;
  description?: string;
  tags?: string[];
  privacy?: "public" | "unlisted" | "private";
  categoryId?: string;
}

export interface UploadResult {
  videoId: string;
  url: string;
  shortsUrl: string;
  title: string;
  publishedAt: string;
  quotaUsed: number;
}

export interface VideoMetrics {
  videoId: string;
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  // Derived
  ageHours: number;
  viewsPerHour: number;
  engagementRate: number;
}

export interface VideoSummary {
  videoId: string;
  title: string;
  publishedAt: string;
  views: number;
  thumbnailUrl: string;
}

export interface QuotaStatus {
  date: string;
  used: number;
  remaining: number;
  limit: number;
  uploadsRemaining: number;
  resetsAt: string;
}

export interface ListOptions {
  limit?: number;
  since?: string; // Duration: "24h", "7d"
}

/**
 * YouTube session interface
 */
export interface YouTubeSession {
  readonly channel: ChannelInfo;

  upload(video: VideoUpload): Promise<UploadResult>;
  delete(videoId: string): Promise<void>;
  getMetrics(videoId: string): Promise<VideoMetrics>;
  listVideos(options?: ListOptions): Promise<VideoSummary[]>;
  getQuota(): Promise<QuotaStatus>;
}

/**
 * YouTube adapter interface
 */
export interface YouTubeAdapter {
  /**
   * Start OAuth flow and create a new session
   */
  authenticate(): Promise<YouTubeSession>;

  /**
   * Restore session from stored credentials
   */
  restoreSession(): Promise<YouTubeSession>;

  /**
   * Check if credentials exist
   */
  hasCredentials(): boolean;
}
