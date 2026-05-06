/**
 * Credentials for authenticating with Instagram
 */
export interface InstagramCredentials {
  /** Instagram Graph API access token */
  accessToken: string;
  /** Instagram Business Account ID */
  businessAccountId: string;
}

/**
 * Serializable session state for persistence
 */
export interface SessionState {
  /** Instagram Graph API access token */
  accessToken: string;
  /** Instagram Business Account ID */
  businessAccountId: string;
  /** Instagram username */
  username: string;
  /** ISO timestamp when session was created */
  created: string;
  /** Which adapter this session uses */
  adapter: string;
}

/**
 * Options for posting a photo
 */
export interface PhotoPostOptions {
  /** URL of the image to post (must be publicly accessible) */
  imageUrl: string;
  /** Post caption */
  caption?: string;
}

/**
 * Options for posting a video
 */
export interface VideoPostOptions {
  /** URL of the video to post (must be publicly accessible) */
  videoUrl: string;
  /** Post caption */
  caption?: string;
  /** Thumbnail/cover image URL */
  coverUrl?: string;
}

/**
 * Options for posting a reel
 */
export interface ReelPostOptions {
  /** URL of the video to post as a reel (must be publicly accessible) */
  videoUrl: string;
  /** Reel caption */
  caption?: string;
  /** Cover image URL */
  coverUrl?: string;
  /** Share to feed as well (default: true) */
  shareToFeed?: boolean;
}

/**
 * Result of a post operation
 */
export interface PostResult {
  /** The post/container ID */
  id: string;
  /** Current status of the post */
  status: "published" | "in_progress" | "error";
  /** Status message */
  message?: string;
}

/**
 * Status of a post/upload
 */
export interface PostStatus {
  /** The post/container ID */
  id: string;
  /** Current status */
  status: "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";
  /** Status code from the API */
  statusCode?: string;
  /** Error message if status is ERROR */
  errorMessage?: string;
}

/**
 * Analytics/insights data for a media post
 */
export interface MediaInsights {
  /** @deprecated Removed in Graph API v22.0+. Always returns 0. Use `reach` instead. */
  impressions: number;
  reach: number;
  /** Only present for VIDEO and REELS media types; undefined for photos/carousels */
  videoViews?: number;
  saved: number;
  likes: number;
  comments: number;
  shares: number;
}

/**
 * Profile information
 */
export interface ProfileInfo {
  /** Instagram username */
  username: string;
  /** Display name */
  name: string;
  /** Bio/description */
  biography: string;
  /** Number of followers */
  followersCount: number;
  /** Number of accounts following */
  followsCount: number;
  /** Number of media posts */
  mediaCount: number;
  /** Profile picture URL */
  profilePictureUrl: string;
  /** Website URL */
  website: string;
}

/**
 * Instagram session - represents an authenticated connection
 *
 * Sessions encapsulate auth state and provide a clean API
 * without leaking adapter-specific parameters.
 */
export interface InstagramSession {
  /** Instagram Business Account ID */
  readonly accountId: string;
  /** Instagram username */
  readonly username: string;
  /** Serializable credentials for session persistence */
  readonly credentials: SessionState;

  /** Post a photo */
  postPhoto(options: PhotoPostOptions): Promise<PostResult>;

  /** Post a video */
  postVideo(options: VideoPostOptions): Promise<PostResult>;

  /** Post a reel */
  postReel(options: ReelPostOptions): Promise<PostResult>;

  /** Check the status of a post/upload */
  getPostStatus(postId: string): Promise<PostStatus>;

  /** Get profile information */
  getProfile(): Promise<ProfileInfo>;

  /** Get analytics/insights for a media post */
  getMediaInsights(mediaId: string): Promise<MediaInsights>;

  /** Optional cleanup */
  close?(): Promise<void>;
}

/**
 * Instagram adapter interface - factory for creating sessions
 */
export interface InstagramAdapter {
  /** Human-readable name of this adapter */
  readonly name: string;

  /** Create a new session from credentials */
  createSession(credentials: InstagramCredentials): Promise<InstagramSession>;

  /** Restore a session from saved state */
  restoreSession(savedState: SessionState): InstagramSession;
}
