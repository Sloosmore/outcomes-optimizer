# agent-youtube Design

CLI tool for YouTube Shorts automation with feedback loop support.

## Overview

| Feature | Value |
|---------|-------|
| **API** | YouTube Data API v3 |
| **Auth** | OAuth 2.0 (Desktop app flow) |
| **Quota** | 10,000 units/day (free), 100 units/upload |
| **Max uploads/day** | 100 on free tier |
| **Shorts spec** | ≤60 sec, 9:16 vertical, #Shorts in title/desc |

## Commands

```bash
# Authentication
agent-youtube auth                    # OAuth flow, stores refresh token
agent-youtube auth --status           # Check if authenticated

# Upload
agent-youtube upload <file>           # Upload video as Short
  --title "Video title #Shorts"       # Required
  --description "Description"         # Optional
  --tags "tag1,tag2"                  # Optional
  --privacy public|unlisted|private   # Default: public

# Metrics
agent-youtube metrics <videoId>       # Get video stats
agent-youtube metrics <videoId> --json

# List
agent-youtube list                    # List recent uploads
agent-youtube list --limit 20         # Limit results
agent-youtube list --since 24h        # Filter by time

# Quota
agent-youtube quota                   # Check remaining daily quota

# Channel info
agent-youtube whoami                  # Show authenticated channel
```

## Architecture

Follows `packages/CLAUDE.md` session-based adapter pattern:

```typescript
interface YouTubeAdapter {
  createSession(credentials: OAuthCredentials): Promise<YouTubeSession>;
  restoreSession(refreshToken: string): Promise<YouTubeSession>;
}

interface YouTubeSession {
  readonly channelId: string;
  readonly channelName: string;

  upload(video: VideoUpload): Promise<UploadResult>;
  getMetrics(videoId: string): Promise<VideoMetrics>;
  listVideos(options?: ListOptions): Promise<VideoSummary[]>;
  getQuota(): Promise<QuotaStatus>;
}
```

## Data Types

```typescript
interface VideoUpload {
  file: string;              // Path to video file
  title: string;             // Must include #Shorts for Shorts
  description?: string;
  tags?: string[];
  privacy?: 'public' | 'unlisted' | 'private';
  categoryId?: string;       // Default: 22 (People & Blogs)
}

interface UploadResult {
  videoId: string;
  url: string;               // https://youtube.com/shorts/{videoId}
  quotaUsed: number;         // 100 units
  publishedAt: string;       // ISO timestamp
}

interface VideoMetrics {
  videoId: string;
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  // Derived metrics
  ageHours: number;
  viewsPerHour: number;
  engagementRate: number;    // (likes + comments) / views
}

interface VideoSummary {
  videoId: string;
  title: string;
  publishedAt: string;
  views: number;
  thumbnail: string;
}

interface QuotaStatus {
  used: number;
  remaining: number;
  limit: number;             // 10,000
  resetsAt: string;          // Midnight PT
  uploadsRemaining: number;  // remaining / 100
}

interface ListOptions {
  limit?: number;            // Default: 10
  since?: string;            // Duration string: "24h", "7d"
}
```

## State Storage

```
~/.agent-youtube/
├── credentials.json         # OAuth refresh token (encrypted)
├── channel.json            # Channel ID, name (cached)
├── quota.json              # Daily quota tracking
└── uploads.json            # Upload history for metrics
```

### credentials.json
```json
{
  "refresh_token": "1//...",
  "access_token": "ya29...",
  "expires_at": "2026-01-25T10:00:00Z",
  "token_type": "Bearer"
}
```

### quota.json
```json
{
  "date": "2026-01-25",
  "used": 1500,
  "operations": [
    { "type": "upload", "cost": 100, "at": "2026-01-25T08:00:00Z" },
    { "type": "list", "cost": 1, "at": "2026-01-25T08:01:00Z" }
  ]
}
```

## OAuth Flow

1. User runs `agent-youtube auth`
2. CLI opens browser to Google OAuth consent screen
3. User grants YouTube permissions
4. Google redirects to `http://localhost:PORT/callback`
5. CLI exchanges code for tokens
6. Refresh token stored in `~/.agent-youtube/credentials.json`

### Required Scopes
```
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube.readonly
```

### GCP Setup Required
User must create:
1. Google Cloud Project
2. Enable YouTube Data API v3
3. Create OAuth 2.0 credentials (Desktop app)
4. Download `client_secrets.json`

Environment variable: `YOUTUBE_CLIENT_SECRETS_PATH` or default `~/.agent-youtube/client_secrets.json`

## API Endpoints Used

| Operation | Endpoint | Cost |
|-----------|----------|------|
| Upload | `videos.insert` | 100 |
| Get metrics | `videos.list` | 1 |
| List videos | `search.list` | 100 |
| List uploads | `playlistItems.list` | 1 |
| Channel info | `channels.list` | 1 |

Note: Use `playlistItems.list` on uploads playlist instead of `search.list` to save quota (1 vs 100 units).

## Shorts Detection

YouTube automatically categorizes as Short if:
- Duration ≤ 60 seconds
- Aspect ratio 9:16 (vertical)
- Contains `#Shorts` in title or description (recommended)

The CLI should:
1. Validate video duration before upload
2. Warn if aspect ratio isn't 9:16
3. Auto-append `#Shorts` to title if missing

## Error Handling

| Error | Action |
|-------|--------|
| Token expired | Auto-refresh using refresh_token |
| Quota exceeded | Return clear error with reset time |
| Upload failed | Return error with YouTube error code |
| Invalid video | Validate before upload, clear message |
| Network error | Retry with exponential backoff (max 3) |

## Dependencies

```json
{
  "googleapis": "^140.0.0",
  "open": "^10.0.0",
  "commander": "^13.0.0"
}
```

## File Structure

```
packages/agent-youtube/
├── package.json
├── tsconfig.json
├── bin/
│   └── agent-youtube.js        # CLI entry point
├── src/
│   ├── index.ts                # Export public API
│   ├── config.ts               # Constants, defaults
│   ├── cli.ts                  # Commander setup
│   ├── adapters/
│   │   ├── types.ts            # YouTubeAdapter, YouTubeSession
│   │   ├── oauth.ts            # OAuth flow implementation
│   │   └── youtube.ts          # YouTube API adapter
│   ├── commands/
│   │   ├── auth.ts             # auth command
│   │   ├── upload.ts           # upload command
│   │   ├── metrics.ts          # metrics command
│   │   ├── list.ts             # list command
│   │   ├── quota.ts            # quota command
│   │   └── whoami.ts           # whoami command
│   ├── state/
│   │   ├── credentials.ts      # Token storage
│   │   ├── quota.ts            # Quota tracking
│   │   └── uploads.ts          # Upload history
│   └── utils/
│       ├── video.ts            # Video validation
│       └── format.ts           # Output formatting
└── README.md
```

## Usage Examples

### First-time setup
```bash
# 1. Download client_secrets.json from GCP
# 2. Authenticate
agent-youtube auth
# Opens browser, grants permissions, stores token

# 3. Verify
agent-youtube whoami
# Channel: @YourChannel (UC...)
```

### Upload workflow
```bash
# Generate video with agent-media
agent-media video "Cat playing piano" --duration 30 --aspect-ratio 9:16 --output cat.mp4

# Wait for completion, download
agent-media video --download <jobId> --output cat.mp4

# Upload to YouTube
agent-youtube upload cat.mp4 --title "Cat plays Beethoven #Shorts"
# Uploaded: https://youtube.com/shorts/abc123
# Quota used: 100/10000
```

### Metrics workflow
```bash
# Check performance after 24h
agent-youtube list --since 24h --json
# [{"videoId": "abc123", "views": 1234, ...}]

agent-youtube metrics abc123
# Views: 1,234 (51.4/hr)
# Likes: 89
# Comments: 12
# Engagement: 8.2%
```

## Integration with youtube-growth skill

The skill uses this CLI for the feedback loop:

```bash
# Skill algorithm:
# 1. Get metrics for recent posts
METRICS=$(agent-youtube list --since 24h --json)

# 2. Generate content with learnings
agent-media video "..." --duration 30 --aspect-ratio 9:16

# 3. Upload
agent-youtube upload video.mp4 --title "..."

# 4. Track for next iteration
echo "posted at $(date)" >> state/history.yaml
```

## Success Criteria

1. `agent-youtube auth` completes OAuth flow
2. `agent-youtube upload video.mp4 --title "Test #Shorts"` uploads successfully
3. `agent-youtube metrics <id>` returns view count
4. `agent-youtube quota` shows accurate remaining quota
5. Full cycle: generate → upload → get metrics works end-to-end
